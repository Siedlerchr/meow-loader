import { createDecipheriv, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { M3U8Encryption, M3U8Map, M3U8Segment } from './m3u8-parser';
import { formatBytes } from './display';
import { SegmentLimitError } from './errors';
import type { NetworkClient } from './network';
import { readResponseBytes } from './network';
import { createSegmentValidator } from './segment-validation';
import type { HlsContainer } from './segment-validation';
import { redactUrl } from './url';

const HEADER_TIMEOUT_MS = 120_000;
const INACTIVITY_TIMEOUT_MS = 120_000;

export interface DownloadSegmentOptions {
  network: NetworkClient;
  keyCache: Map<string, Buffer>;
  maxBytes: number;
  container: HlsContainer;
  onProgress?: (bytes: number) => void;
}

export interface DownloadedSegment {
  size: number;
  sha256: string;
}

export async function downloadSegmentToFile(
  segment: M3U8Segment,
  baseUrl: string,
  destination: string,
  options: DownloadSegmentOptions,
): Promise<DownloadedSegment> {
  const url = resolveUrl(segment.uri, baseUrl);
  const iv = segment.encryption
    ? segment.encryption.iv
      ? parseIv(segment.encryption.iv)
      : ivFromSequence(segment.sequence)
    : undefined;

  return downloadFile(url, baseUrl, destination, options, {
    encryption: segment.encryption,
    iv,
    label: 'segment',
  });
}

export async function downloadInitSegmentToFile(
  map: M3U8Map,
  baseUrl: string,
  destination: string,
  options: DownloadSegmentOptions,
): Promise<DownloadedSegment> {
  const url = resolveUrl(map.uri, baseUrl);
  let iv: Uint8Array | undefined;

  if (map.encryption) {
    if (!map.encryption.iv) {
      throw new Error('Encrypted initialization segments require an explicit #EXT-X-KEY IV');
    }
    iv = parseIv(map.encryption.iv);
  }

  return downloadFile(url, baseUrl, destination, options, {
    encryption: map.encryption,
    iv,
    label: 'initialization segment',
    requireFtyp: true,
  });
}

interface DownloadFileSpec {
  encryption?: M3U8Encryption;
  iv?: Uint8Array;
  label: string;
  requireFtyp?: boolean;
}

async function downloadFile(
  url: string,
  baseUrl: string,
  destination: string,
  options: DownloadSegmentOptions,
  spec: DownloadFileSpec,
): Promise<DownloadedSegment> {
  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await options.network.fetch(url, {}, {
      label: spec.label,
      signal: controller.signal,
      timeoutMs: 0,
    });
  } finally {
    clearTimeout(headerTimer);
  }

  if (!response.ok) {
    throw new Error(`Failed to download ${spec.label}: ${redactUrl(url)} (${response.status})`);
  }
  if (!response.body) {
    throw new Error(`The ${spec.label} response has no body: ${redactUrl(url)}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
    await response.body.cancel();
    throw new SegmentLimitError(
      `The ${spec.label} is ${formatBytes(contentLength)}, above the ${formatBytes(options.maxBytes)} limit. Use --max-segment-size or --max-download to raise it.`,
    );
  }

  let stream: Readable = Readable.fromWeb(
    response.body as import('node:stream/web').ReadableStream<Uint8Array>,
  );

  if (spec.encryption) {
    const key = await getKey(spec.encryption, baseUrl, options);
    stream = stream.pipe(createDecipheriv('aes-128-cbc', key, Buffer.from(spec.iv!)));
  }

  let inactivityTimer = setTimeout(() => controller.abort(), INACTIVITY_TIMEOUT_MS);
  const resetInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => controller.abort(), INACTIVITY_TIMEOUT_MS);
  };

  const hash = createHash('sha256');
  const validator = createSegmentValidator(options.container, {
    requireFtyp: spec.requireFtyp,
  });
  let size = 0;

  const inspector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      resetInactivity();
      size += chunk.byteLength;

      if (size > options.maxBytes) {
        callback(
          new SegmentLimitError(
            `The ${spec.label} is above the ${formatBytes(options.maxBytes)} limit. Use --max-segment-size or --max-download to raise it.`,
          ),
        );
        return;
      }

      hash.update(chunk);
      if (!validator.update(chunk)) {
        callback(new Error(validityError(spec.label, options.container)));
        return;
      }

      options.onProgress?.(size);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      stream,
      inspector,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(inactivityTimer);
  }

  if (!validator.valid) {
    await rm(destination, { force: true }).catch(() => {});
    throw new Error(validityError(spec.label, options.container));
  }

  return { size, sha256: hash.digest('hex') };
}

function validityError(label: string, container: HlsContainer): string {
  return container === 'fmp4'
    ? `Downloaded ${label} is not a valid fragmented MP4 file`
    : `Downloaded ${label} is not a valid MPEG-TS segment`;
}

export function resolveUrl(uri: string, baseUrl: string): string {
  try {
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      return uri;
    }
    return new URL(uri, baseUrl).href;
  } catch {
    throw new Error('Invalid segment or key URL');
  }
}

/**
 * HLS uses the segment media sequence number as a 128-bit big-endian IV when
 * the #EXT-X-KEY IV attribute is not present.
 */
export function ivFromSequence(sequence: number): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Invalid media sequence number: ${sequence}`);
  }

  const iv = new Uint8Array(16);
  let value = BigInt(sequence);

  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(value & 0xffn);
    value >>= 8n;
  }

  return iv;
}

async function getKey(
  encryption: M3U8Encryption,
  baseUrl: string,
  options: DownloadSegmentOptions,
): Promise<Buffer> {
  const keyUrl = resolveUrl(encryption.uri, baseUrl);
  const cached = options.keyCache.get(keyUrl);
  if (cached) {
    return cached;
  }
  if (options.keyCache.size >= 10_000) {
    throw new SegmentLimitError('Too many unique encryption keys in this playlist');
  }

  const response = await options.network.fetch(keyUrl, {}, { label: 'encryption key' });
  if (!response.ok) {
    throw new Error(`Failed to download encryption key: ${redactUrl(keyUrl)} (${response.status})`);
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = await readResponseBytes(response, 16, 'Encryption key');
  } catch (error) {
    throw new SegmentLimitError(error instanceof Error ? error.message : String(error));
  }

  const key = Buffer.from(keyBytes);
  if (key.byteLength !== 16) {
    throw new Error(
      `Invalid AES-128 key length at ${redactUrl(keyUrl)}: expected 16 bytes, got ${key.byteLength}`,
    );
  }

  options.keyCache.set(keyUrl, key);
  return key;
}

function parseIv(value: string): Uint8Array {
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{1,32}$/.test(hex)) {
    throw new Error(`Invalid AES-128 IV: ${value}`);
  }

  const padded = hex.padStart(32, '0');
  const iv = new Uint8Array(16);
  for (let i = 0; i < iv.length; i++) {
    iv[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }

  return iv;
}
