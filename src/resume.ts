import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { M3U8Map, M3U8Segment } from './m3u8-parser';
import { scanSegmentFile } from './segment-validation';
import type { HlsContainer } from './segment-validation';
import { redactUrl } from './url';

export const RESUME_METADATA_FILENAME = 'meow-loader.resume.json';
const RESUME_VERSION = 2;

export interface ResumeSegment {
  fileName: string;
  size: number;
  sha256: string;
}

export interface ResumeInitSegment {
  fileName: string;
  size: number;
  sha256: string;
}

export interface ResumeMetadata {
  version: typeof RESUME_VERSION;
  sourceUrlHash: string;
  mediaPlaylistUrlHash: string;
  sourceDisplay: string;
  mediaPlaylistUrlDisplay: string;
  segmentCount: number;
  segmentFingerprint: string;
  segments: Record<string, ResumeSegment>;
  /** Optional for directories created before fMP4 support. */
  container?: HlsContainer;
  /** Present for fMP4 playlists that declare #EXT-X-MAP. */
  initSegment?: ResumeInitSegment;
  /** Optional for directories created before this field existed. */
  durationSeconds?: number;
}

export interface ResumeState {
  metadata: ResumeMetadata;
  completed: Set<number>;
  initValid: boolean;
  persist: boolean;
}

export async function initializeResumeState(options: {
  dir: string;
  sourceUrl: string;
  mediaPlaylistUrl: string;
  segments: M3U8Segment[];
  persist: boolean;
  tempDir?: string;
  container: HlsContainer;
  map?: M3U8Map;
}): Promise<ResumeState> {
  const expected = createMetadata(
    options.sourceUrl,
    options.mediaPlaylistUrl,
    options.segments,
    options.container,
    options.map,
  );

  if (!options.persist) {
    return { metadata: expected, completed: new Set(), initValid: false, persist: false };
  }

  const metadataPath = join(options.dir, RESUME_METADATA_FILENAME);
  if (existsSync(metadataPath)) {
    const existing = parseMetadata(await readFile(metadataPath, 'utf8'), metadataPath);
    assertSamePlaylist(existing, expected);
    if (existing.container && existing.container !== expected.container) {
      throw new Error(
        `Resume directory holds ${existing.container} segments, but this playlist is ${expected.container}`,
      );
    }
    expected.segments = existing.segments;
    expected.initSegment = existing.initSegment;
  }

  await saveResumeMetadata(options.dir, expected, options.tempDir);
  const { completed, initValid } = await validateCompletedSegments(options.dir, expected);
  await saveResumeMetadata(options.dir, expected, options.tempDir);

  return { metadata: expected, completed, initValid, persist: true };
}

export interface LoadedResumeState {
  metadata: ResumeMetadata;
  completed: Set<number>;
  initValid: boolean;
}

/**
 * Load and validate a resume directory without a playlist. Used by
 * --merge-only when the original endpoint is no longer available.
 */
export async function loadResumeState(dir: string): Promise<LoadedResumeState> {
  const metadataPath = join(dir, RESUME_METADATA_FILENAME);
  let raw: string;

  try {
    raw = await readFile(metadataPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No ${RESUME_METADATA_FILENAME} found in ${dir}. Use --resume <dir> with the original playlist instead.`,
      );
    }
    throw error;
  }

  const metadata = parseMetadata(raw, metadataPath);
  const { completed, initValid } = await validateCompletedSegments(dir, metadata);
  return { metadata, completed, initValid };
}

export function recordSegment(
  metadata: ResumeMetadata,
  index: number,
  fileName: string,
  size: number,
  sha256: string,
): void {
  metadata.segments[String(index)] = { fileName, size, sha256 };
}

export function recordInitSegment(
  metadata: ResumeMetadata,
  fileName: string,
  size: number,
  sha256: string,
): void {
  metadata.initSegment = { fileName, size, sha256 };
}

export async function saveResumeMetadata(
  dir: string,
  metadata: ResumeMetadata,
  tempDir = dir,
): Promise<void> {
  const metadataPath = join(dir, RESUME_METADATA_FILENAME);
  const temporaryPath = join(tempDir, `${RESUME_METADATA_FILENAME}.${process.pid}.${randomUUID()}.tmp`);

  await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, metadataPath);
}

export async function cleanupResumeState(dir: string, metadata: ResumeMetadata): Promise<void> {
  for (const segment of Object.values(metadata.segments)) {
    await rm(join(dir, segment.fileName), { force: true });
    await rm(join(dir, `${segment.fileName}.part`), { force: true });
  }

  if (metadata.initSegment) {
    await rm(join(dir, metadata.initSegment.fileName), { force: true });
    await rm(join(dir, `${metadata.initSegment.fileName}.part`), { force: true });
  }

  await rm(join(dir, RESUME_METADATA_FILENAME), { force: true });
}

function createMetadata(
  sourceUrl: string,
  mediaPlaylistUrl: string,
  segments: M3U8Segment[],
  container: HlsContainer,
  map: M3U8Map | undefined,
): ResumeMetadata {
  return {
    version: RESUME_VERSION,
    sourceUrlHash: hashUrlIdentity(sourceUrl),
    mediaPlaylistUrlHash: hashUrl(mediaPlaylistUrl),
    sourceDisplay: redactUrl(sourceUrl),
    mediaPlaylistUrlDisplay: redactUrl(mediaPlaylistUrl),
    segmentCount: segments.length,
    segmentFingerprint: fingerprintSegments(segments, map),
    segments: {},
    container,
    durationSeconds: segments.reduce((sum, segment) => sum + segment.duration, 0),
  };
}

function parseMetadata(raw: string, path: string): ResumeMetadata {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidMetadataError(path);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidMetadataError(path);
  }

  const candidate = parsed as Partial<ResumeMetadata>;
  if (
    candidate.version !== RESUME_VERSION ||
    typeof candidate.sourceUrlHash !== 'string' ||
    typeof candidate.mediaPlaylistUrlHash !== 'string' ||
    typeof candidate.sourceDisplay !== 'string' ||
    typeof candidate.mediaPlaylistUrlDisplay !== 'string' ||
    !Number.isInteger(candidate.segmentCount) ||
    (candidate.segmentCount ?? -1) < 0 ||
    typeof candidate.segmentFingerprint !== 'string' ||
    !candidate.segments ||
    typeof candidate.segments !== 'object' ||
    Array.isArray(candidate.segments)
  ) {
    throw invalidMetadataError(path);
  }

  if (
    candidate.durationSeconds !== undefined &&
    (typeof candidate.durationSeconds !== 'number' ||
      !Number.isFinite(candidate.durationSeconds) ||
      candidate.durationSeconds < 0)
  ) {
    throw invalidMetadataError(path);
  }

  if (
    candidate.container !== undefined &&
    candidate.container !== 'mpegts' &&
    candidate.container !== 'fmp4'
  ) {
    throw invalidMetadataError(path);
  }

  if (candidate.initSegment !== undefined) {
    const init = candidate.initSegment;
    if (
      !init ||
      typeof init !== 'object' ||
      typeof init.fileName !== 'string' ||
      !/^init\.(?:mp4|m4s)$/.test(init.fileName) ||
      !Number.isInteger(init.size) ||
      init.size < 0 ||
      typeof init.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(init.sha256)
    ) {
      throw invalidMetadataError(path);
    }
  }

  for (const [key, value] of Object.entries(candidate.segments)) {
    if (
      !/^\d+$/.test(key) ||
      !value ||
      typeof value !== 'object' ||
      typeof value.fileName !== 'string' ||
      !/^segment_\d+\.(?:ts|m4s)$/.test(value.fileName) ||
      !Number.isInteger(value.size) ||
      value.size < 0 ||
      typeof value.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    ) {
      throw invalidMetadataError(path);
    }
  }

  return candidate as ResumeMetadata;
}

function invalidMetadataError(path: string): Error {
  return new Error(
    `Invalid or outdated resume metadata: ${path}. Delete it or use a new resume directory.`,
  );
}

function assertSamePlaylist(actual: ResumeMetadata, expected: ResumeMetadata): void {
  if (actual.sourceUrlHash !== expected.sourceUrlHash) {
    throw new Error(
      `Resume directory belongs to a different playlist: expected ${actual.sourceDisplay}, received ${expected.sourceDisplay}`,
    );
  }

  if (actual.mediaPlaylistUrlHash !== expected.mediaPlaylistUrlHash) {
    throw new Error(
      `Resume directory belongs to a different media playlist or variant: expected ${actual.mediaPlaylistUrlDisplay}, received ${expected.mediaPlaylistUrlDisplay}`,
    );
  }

  if (actual.segmentCount !== expected.segmentCount) {
    throw new Error(
      `Resume directory has ${actual.segmentCount} segments, but this playlist has ${expected.segmentCount}`,
    );
  }

  if (actual.segmentFingerprint !== expected.segmentFingerprint) {
    throw new Error('Resume directory belongs to a different version of this playlist');
  }
}

async function validateCompletedSegments(
  dir: string,
  metadata: ResumeMetadata,
): Promise<{ completed: Set<number>; initValid: boolean }> {
  const completed = new Set<number>();
  const container = metadata.container ?? 'mpegts';

  let initValid = false;
  const init = metadata.initSegment;
  if (init) {
    const initPath = join(dir, init.fileName);
    const info = await lstat(initPath).catch(() => undefined);

    if (!info?.isFile() || info.isSymbolicLink() || info.size !== init.size) {
      await rm(initPath, { force: true });
      delete metadata.initSegment;
    } else {
      const scan = await scanSegmentFile(initPath, container, { requireFtyp: true }).catch(
        () => undefined,
      );
      if (!scan || !scan.valid || scan.size !== init.size || scan.sha256 !== init.sha256) {
        await rm(initPath, { force: true });
        delete metadata.initSegment;
      } else {
        initValid = true;
      }
    }
  }

  for (const [key, segment] of Object.entries(metadata.segments)) {
    const index = Number(key);
    const path = join(dir, segment.fileName);

    if (!Number.isInteger(index) || index < 0 || index >= metadata.segmentCount) {
      delete metadata.segments[key];
      continue;
    }

    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== segment.size) {
      await rm(path, { force: true });
      delete metadata.segments[key];
      continue;
    }

    const scan = await scanSegmentFile(path, container).catch(() => undefined);
    if (!scan || !scan.valid || scan.size !== segment.size || scan.sha256 !== segment.sha256) {
      await rm(path, { force: true });
      delete metadata.segments[key];
      continue;
    }

    completed.add(index);
  }

  return { completed, initValid };
}

function fingerprintSegments(segments: M3U8Segment[], map: M3U8Map | undefined): string {
  const payload = segments.map(segment => ({
    duration: segment.duration,
    sequence: segment.sequence,
    uri: stripQuery(segment.uri),
    encryption: segment.encryption
      ? {
          uri: stripQuery(segment.encryption.uri),
          iv: segment.encryption.iv ?? null,
        }
      : null,
  }));

  // Keep the fingerprint of MPEG-TS playlists byte-identical to earlier
  // versions so existing resume directories remain usable.
  const serialized = JSON.stringify(payload);
  if (!map) {
    return hashString(serialized);
  }

  const mapIdentity = {
    uri: stripQuery(map.uri),
    byterange: map.byterange ?? null,
    encryption: map.encryption
      ? {
          uri: stripQuery(map.encryption.uri),
          iv: map.encryption.iv ?? null,
        }
      : null,
  };

  return hashString(`${serialized}\n${JSON.stringify(mapIdentity)}`);
}

function hashUrl(url: string): string {
  return hashString(url);
}

function hashUrlIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    return hashString(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return hashString(url);
  }
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stripQuery(value: string): string {
  const index = value.search(/[?#]/);
  return index === -1 ? value : value.slice(0, index);
}
