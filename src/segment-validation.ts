import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const MPEG_TS_PACKET_SIZE = 188;
const MPEG_TS_SYNC_BYTE = 0x47;
const MP4_HEADER_BYTES = 8;

// Top-level boxes that may legally start an fMP4 media segment or init file.
const MP4_BOX_TYPES = new Set([
  'ftyp',
  'styp',
  'moof',
  'moov',
  'sidx',
  'ssix',
  'free',
  'skip',
  'mdat',
  'emsg',
  'prft',
]);

export type HlsContainer = 'mpegts' | 'fmp4';

export interface SegmentValidator {
  update(chunk: Uint8Array): boolean;
  readonly size: number;
  readonly valid: boolean;
}

/**
 * Validate MPEG-TS packet structure before treating a download as complete;
 * this catches HTML error pages and truncated responses that still return
 * HTTP 200.
 */
export class MpegTsValidator implements SegmentValidator {
  private bytes = 0;
  private invalid = false;

  update(chunk: Uint8Array): boolean {
    const chunkStart = this.bytes;

    for (let index = 0; index < chunk.byteLength; index++) {
      if ((chunkStart + index) % MPEG_TS_PACKET_SIZE === 0 && chunk[index] !== MPEG_TS_SYNC_BYTE) {
        this.invalid = true;
      }
    }

    this.bytes += chunk.byteLength;
    return !this.invalid;
  }

  get size(): number {
    return this.bytes;
  }

  get valid(): boolean {
    return !this.invalid && this.bytes >= MPEG_TS_PACKET_SIZE && this.bytes % MPEG_TS_PACKET_SIZE === 0;
  }
}

/**
 * Validate the first MP4 box of an fMP4 initialization segment or media
 * fragment. Initialization segments must start with an "ftyp" box; media
 * fragments start with "styp", "moof", "sidx", and friends.
 */
export class Mp4Validator implements SegmentValidator {
  private readonly requireFtyp: boolean;
  private header: { size: number; type: string } | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private bytes = 0;

  constructor(options: { requireFtyp?: boolean } = {}) {
    this.requireFtyp = options.requireFtyp ?? false;
  }

  update(chunk: Uint8Array): boolean {
    this.bytes += chunk.byteLength;
    if (this.header) {
      return true;
    }

    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.length < MP4_HEADER_BYTES) {
      return true;
    }

    this.header = {
      size: this.buffer.readUInt32BE(0),
      type: this.buffer.toString('latin1', 4, 8),
    };
    return this.validHeader();
  }

  get size(): number {
    return this.bytes;
  }

  get valid(): boolean {
    return this.bytes > 0 && this.validHeader();
  }

  private validHeader(): boolean {
    if (!this.header) {
      return false;
    }

    const { size, type } = this.header;
    if (!MP4_BOX_TYPES.has(type)) {
      return false;
    }
    if (!(size === 0 || size === 1 || size >= MP4_HEADER_BYTES)) {
      return false;
    }
    if (this.requireFtyp && type !== 'ftyp') {
      return false;
    }

    return true;
  }
}

export function createSegmentValidator(
  container: HlsContainer,
  options: { requireFtyp?: boolean } = {},
): SegmentValidator {
  return container === 'fmp4' ? new Mp4Validator(options) : new MpegTsValidator();
}

export interface SegmentFileScan {
  size: number;
  sha256: string;
  valid: boolean;
}

export async function scanSegmentFile(
  filePath: string,
  container: HlsContainer,
  options: { requireFtyp?: boolean } = {},
): Promise<SegmentFileScan> {
  const hash = createHash('sha256');
  const validator = createSegmentValidator(container, options);
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    hash.update(buffer);

    if (!validator.update(buffer)) {
      stream.destroy();
      break;
    }
  }

  return {
    size: validator.size,
    sha256: hash.digest('hex'),
    valid: validator.valid,
  };
}

export async function scanMpegTsFile(filePath: string): Promise<SegmentFileScan> {
  return scanSegmentFile(filePath, 'mpegts');
}
