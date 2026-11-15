#!/usr/bin/env node
import {
  parseM3U8,
  sortAudioRenditions,
  sortSubtitleRenditions,
  sortVariantsByBandwidth,
} from './src/m3u8-parser';
import type {
  M3U8Map,
  M3U8Media,
  M3U8Playlist,
  M3U8Segment,
  M3U8Variant,
} from './src/m3u8-parser';
import {
  downloadInitSegmentToFile,
  downloadSegmentToFile,
  resolveUrl,
} from './src/downloader';
import { abortActiveMerge, mergeToMp4, muxToMp4 } from './src/merger';
import type { HlsContainer } from './src/segment-validation';
import {
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_PLAYLIST_MAX_BYTES,
  parseArgs,
  USAGE,
} from './src/args';
import { formatBytes, formatDuration, sanitizeForDisplay, sanitizeMultiline } from './src/display';
import { DiskSpaceError, DownloadLimitError, SegmentLimitError } from './src/errors';
import { NetworkClient, readResponseBytes, readResponseText, UrlPolicyError } from './src/network';
import { getUniqueFilePath, pickAvailableOutputPath } from './src/output-path';
import {
  DownloadProgress,
  ParallelDownloadProgress,
  ValidationProgress,
} from './src/progress';
import { validateMp4Output } from './src/output-validation';
import { isValidWebVttSegment, mergeWebVttSegments } from './src/webvtt';
import {
  cleanupResumeState,
  initializeResumeState,
  loadResumeState,
  recordAudioInitSegment,
  recordAudioSegment,
  recordInitSegment,
  recordSegment,
  saveResumeMetadata,
} from './src/resume';
import type {
  LoadedResumeState,
  ResumeMetadata,
  ResumeState,
  ResumeTrack,
  ResumeValidationCallback,
} from './src/resume';
import { redactUrl } from './src/url';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { constants, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse as parsePath, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { ParsedArgs } from './src/args';

const execFileAsync = promisify(execFile);
const MAX_VARIANTS = 1_000;
const MAX_EXPECTED_DURATION = 366 * 24 * 60 * 60;
const FREE_SPACE_MARGIN = 512 * 1024 ** 2;

function showHelp() {
  console.log(USAGE);
}

function getVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return process.env.npm_package_version ?? '0.0.0-dev';
  }
}

async function checkFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    await execFileAsync('ffprobe', ['-version']);
  } catch {
    throw new Error(
      'ffmpeg and ffprobe are required but not found. Please install ffmpeg and ensure both are in your PATH.',
    );
  }
}

function parseVariantIndex(value: string, count: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid variant index "${sanitizeForDisplay(value, 40)}". Choose 0-${count - 1}`);
  }

  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`Invalid variant index. Choose 0-${count - 1}`);
  }

  return index;
}

function parseRenditionIndex(value: string, count: number, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label} index "${sanitizeForDisplay(value, 40)}". Choose 0-${count - 1}`);
  }

  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`Invalid ${label} index. Choose 0-${count - 1}`);
  }

  return index;
}

function parseAudioIndex(value: string, count: number): number {
  return parseRenditionIndex(value, count, 'audio');
}

function parseSubtitleIndex(value: string, count: number): number {
  return parseRenditionIndex(value, count, 'subtitle');
}

async function selectVariant(variants: M3U8Variant[], variantArg: string | undefined): Promise<M3U8Variant> {
  const sorted = sortVariantsByBandwidth(variants);

  console.log('Master playlist detected. Available variants (highest first):');
  sorted.forEach((variant, index) => {
    const resolution = variant.resolution
      ? ` (${sanitizeForDisplay(variant.resolution, 80)})`
      : '';
    const audio = variant.audioGroup
      ? ` [audio: ${sanitizeForDisplay(variant.audioGroup, 80)}]`
      : '';
    console.log(`  [${index}] ${variant.bandwidth / 1000} kbps${resolution}${audio}`);
  });

  if (variantArg !== undefined) {
    return sorted[parseVariantIndex(variantArg, sorted.length)]!;
  }

  if (!stdin.isTTY) {
    console.log('No TTY detected; selecting the highest quality variant.');
    return sorted[0]!;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const input = await rl.question(`Select variant (0-${sorted.length - 1}, default: 0 highest): `);
    const trimmed = input.trim();
    return trimmed ? sorted[parseVariantIndex(trimmed, sorted.length)]! : sorted[0]!;
  } finally {
    rl.close();
  }
}

interface RenditionSelectionOptions {
  media: M3U8Media[] | undefined;
  groupId: string;
  type: 'AUDIO' | 'SUBTITLES';
  indexArg: string | undefined;
  languageArg?: string;
  label: 'audio' | 'subtitle';
  flagName: string;
  parseIndex: (value: string, count: number) => number;
}

async function selectRenditionForGroup(
  options: RenditionSelectionOptions,
): Promise<M3U8Media | undefined> {
  const candidates =
    options.type === 'AUDIO'
      ? sortAudioRenditions(options.media, options.groupId)
      : sortSubtitleRenditions(options.media, options.groupId);
  const { indexArg, languageArg, label, flagName, parseIndex } = options;

  if (candidates.length === 0) {
    if (indexArg !== undefined || languageArg !== undefined) {
      throw new Error(
        `${flagName} cannot be used: the selected variant has no separate ${label} rendition`,
      );
    }
    return undefined;
  }

  if (candidates.length > 1) {
    console.log(`Available ${label} renditions:`);
    candidates.forEach((rendition, index) => {
      const details = [
        rendition.language,
        rendition.channels ? `${rendition.channels} channels` : undefined,
        rendition.default ? 'default' : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(', ');
      const name = sanitizeForDisplay(rendition.name || rendition.language || 'unnamed', 80);
      console.log(`  [${index}] ${name}${details ? ` (${details})` : ''}`);
    });
  }

  if (indexArg !== undefined) {
    return candidates[parseIndex(indexArg, candidates.length)]!;
  }

  if (languageArg !== undefined) {
    const wanted = languageArg.toLowerCase();
    const languageMatches = candidates.filter((rendition) => {
      const language = rendition.language?.toLowerCase();
      return language === wanted || language?.startsWith(`${wanted}-`);
    });
    const nameMatches = candidates.filter(
      rendition => rendition.name?.toLowerCase() === wanted,
    );
    const matches = languageMatches.length > 0 ? languageMatches : nameMatches;

    if (matches.length === 0) {
      const available = candidates
        .map(rendition => rendition.language || rendition.name || 'unnamed')
        .join(', ');
      throw new Error(
        `No ${label} rendition matches "${sanitizeForDisplay(languageArg, 40)}". Available: ${available}`,
      );
    }

    return matches.find(rendition => rendition.default) ?? matches[0]!;
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  if (!stdin.isTTY) {
    console.log(`No TTY detected; selecting the default ${label} rendition.`);
    return candidates[0]!;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const input = await rl.question(
      `Select ${label} (0-${candidates.length - 1}, default: 0): `,
    );
    const trimmed = input.trim();
    return trimmed ? candidates[parseIndex(trimmed, candidates.length)]! : candidates[0]!;
  } finally {
    rl.close();
  }
}

function validateMediaPlaylist(playlist: M3U8Playlist): number {
  if (playlist.isMaster) {
    throw new Error('Expected a media playlist but received another master playlist');
  }
  if (!playlist.hasEndList) {
    throw new Error('Live or incomplete playlists are not supported (missing #EXT-X-ENDLIST)');
  }
  if (!playlist.segments || playlist.segments.length === 0) {
    throw new Error('No segments found in playlist');
  }
  if (playlist.segments.length > DEFAULT_MAX_SEGMENTS) {
    throw new Error(
      `Playlist has ${playlist.segments.length} segments, above the ${DEFAULT_MAX_SEGMENTS} limit`,
    );
  }

  const expectedDuration = playlist.segments.reduce((sum, segment) => sum + segment.duration, 0);
  if (!Number.isFinite(expectedDuration) || expectedDuration < 0) {
    throw new Error('Playlist duration is invalid or too large');
  }
  if (expectedDuration > MAX_EXPECTED_DURATION) {
    throw new Error(`Playlist duration ${formatDuration(expectedDuration)} is unreasonably large`);
  }

  return expectedDuration;
}

async function resolveOutputPath(requested: string | undefined, force: boolean): Promise<string> {
  const output = requested
    ? resolve(requested)
    : force
      ? resolve('output.mp4')
      : getUniqueFilePath(resolve('output.mp4'));

  if (!/\.mp4$/i.test(output)) {
    throw new Error('Output filename must end with .mp4');
  }

  const existing = await stat(output).catch(() => undefined);
  if (existing?.isDirectory()) {
    throw new Error(`Output path is a directory: ${output}`);
  }
  if (existing && !force) {
    throw new Error(`Output file already exists: ${output}\nUse --force to overwrite it.`);
  }

  const parent = await stat(dirname(output)).catch(() => undefined);
  if (!parent?.isDirectory()) {
    throw new Error(`Output directory does not exist: ${dirname(output)}`);
  }

  return output;
}

async function assertOutputAvailable(output: string, force: boolean): Promise<void> {
  if (force) return;
  const existing = await stat(output).catch(() => undefined);
  if (existing) {
    throw new Error(`Output file already exists: ${output}`);
  }
}

async function prepareWorkingDirectory(
  resumeDir: string | undefined,
): Promise<{ tmpDir: string; ownsTempDir: boolean; workDir: string }> {
  if (!resumeDir) {
    const tmpDir = await mkdtemp(join(tmpdir(), 'meow-'));
    const workDir = await mkdtemp(join(tmpDir, '.meow-loader-'));
    registerWorkDirCleanup(workDir);
    return { tmpDir, ownsTempDir: true, workDir };
  }

  const tmpDir = await realpath(resolve(resumeDir)).catch(() => undefined);
  if (!tmpDir) {
    throw new Error(`Resume directory does not exist: ${resumeDir}`);
  }

  const info = await lstat(tmpDir).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`Resume path is not a directory: ${tmpDir}`);
  }

  await access(tmpDir, constants.W_OK).catch(() => {
    throw new Error(`Resume directory is not writable: ${tmpDir}`);
  });

  if ((info.mode & 0o002) !== 0) {
    console.warn(`Warning: resume directory is world-writable: ${tmpDir}`);
  }

  const workDir = await mkdtemp(join(tmpDir, '.meow-loader-'));
  registerWorkDirCleanup(workDir);
  return { tmpDir, ownsTempDir: false, workDir };
}

function registerWorkDirCleanup(workDir: string): void {
  process.once('exit', () => {
    rmSync(workDir, { recursive: true, force: true });
  });
}

async function getFreeBytes(dir: string): Promise<number | undefined> {
  try {
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return undefined;
  }
}

async function ensureFreeSpace(dir: string, requiredBytes: number, label: string): Promise<void> {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) return;
  const free = await getFreeBytes(dir);
  if (free === undefined) return;
  if (free < requiredBytes) {
    throw new DiskSpaceError(
      `Not enough free space for ${label}: need about ${formatBytes(requiredBytes)}, ${formatBytes(free)} available in ${dir}. Free space or use --resume on another disk.`,
    );
  }
}

async function promptRetry(attempts: number, maxAttempts: number): Promise<'retry' | 'save'> {
  const remaining = Math.max(0, maxAttempts - attempts);
  if (remaining === 0) {
    return 'save';
  }

  const hint = ` (${remaining} attempt${remaining > 1 ? 's' : ''} left)`;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const input = await rl.question(`\n[R]etry${hint}, [S]ave & exit: `);
    const trimmed = input.trim().toLowerCase();
    return trimmed === 'r' || trimmed === 'retry' ? 'retry' : 'save';
  } finally {
    rl.close();
  }
}

async function promptLargeDownload(estimatedBytes: number, limitBytes: number): Promise<boolean> {
  if (!stdin.isTTY) return false;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const input = await rl.question(
      `Estimated download is ${formatBytes(estimatedBytes)}, above the ${formatBytes(limitBytes)} limit. Continue? [y/N] `,
    );
    return /^y(es)?$/i.test(input.trim());
  } finally {
    rl.close();
  }
}

async function replaceSegmentFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if (!isReplaceError(error)) throw error;
    await rm(target, { force: true });
    await rename(source, target);
  }
}

interface DownloadBudget {
  usedBytes: number;
  maxBytes: number;
  maxSegmentBytes: number;
}

interface DownloadTrackOptions {
  kind: 'video' | 'audio';
  segments: M3U8Segment[];
  playlistUrl: string;
  container: HlsContainer;
  map: M3U8Map | undefined;
  tmpDir: string;
  workDir: string;
  network: NetworkClient;
  keyCache: Map<string, Buffer>;
  metadata: ResumeMetadata;
  completed: Set<number>;
  initValid: boolean;
  persist: boolean;
  budget: DownloadBudget;
  concurrency: number;
  maxAttempts: number;
  timeoutMs: number;
}

interface DownloadedTrack {
  segmentPaths: string[];
  initPath?: string;
}

interface TrackProgress {
  startSegment(index: number, expectedBytes?: number): void;
  addBytes(bytes: number): void;
  completeSegment(size: number): void;
  finish(): void;
}

function trackBytes(track: ResumeTrack): number {
  const segments = Object.values(track.segments).reduce((sum, segment) => sum + segment.size, 0);
  return segments + (track.initSegment?.size ?? 0);
}

async function downloadTrack(options: DownloadTrackOptions): Promise<DownloadedTrack | null> {
  const {
    kind,
    segments,
    playlistUrl,
    container,
    map,
    tmpDir,
    workDir,
    network,
    keyCache,
    budget,
  } = options;
  const prefix = kind === 'audio' ? 'audio_' : '';
  const kindLabel = kind === 'audio' ? 'audio ' : '';
  const extension = container === 'fmp4' ? 'm4s' : 'ts';
  const track = kind === 'audio' ? options.metadata.audio : options.metadata;
  if (!track) {
    throw new Error('Resume metadata has no audio track');
  }

  const concurrency = Math.max(1, Math.min(options.concurrency, Math.max(1, segments.length)));
  const trackWorkDir = join(workDir, kind);
  await mkdir(trackWorkDir, { recursive: true });

  let currentBytes = trackBytes(track);
  const initFileName = `${prefix}init.${container === 'fmp4' ? 'mp4' : 'ts'}`;
  let initPath: string | undefined;

  // Bytes reserved by in-flight downloads, so parallel workers cannot exceed
  // --max-download before their sizes are known.
  let reservedBytes = 0;
  const reserveBytes = (): number => {
    const remaining =
      budget.maxBytes > 0 ? budget.maxBytes - budget.usedBytes - reservedBytes : Infinity;
    if (remaining <= 0) {
      throw new DownloadLimitError(
        `Download limit reached (${formatBytes(budget.maxBytes)}). Resume later with: --resume ${tmpDir} --max-download ${formatBytes(budget.maxBytes * 2)}`,
      );
    }

    const slice = Math.min(budget.maxSegmentBytes, remaining);
    reservedBytes += slice;
    return slice;
  };

  const settleBytes = (slice: number, actualBytes: number): void => {
    reservedBytes -= slice;
    budget.usedBytes += actualBytes;
  };

  const releaseBytes = (slice: number): void => {
    reservedBytes -= slice;
  };

  const METADATA_BATCH_INTERVAL_MS = 500;
  const METADATA_BATCH_MAX_RECORDS = 32;
  let saveChain: Promise<void> = Promise.resolve();
  let saveError: unknown;
  let pendingRecords = 0;
  let saveTimer: NodeJS.Timeout | undefined;

  const queueMetadataWrite = async (throwOnError: boolean): Promise<void> => {
    saveChain = saveChain.then(async () => {
      if (saveError) return;
      try {
        await saveResumeMetadata(tmpDir, options.metadata, trackWorkDir);
      } catch (error) {
        saveError = error;
        if (throwOnError) {
          throw error;
        }
      }
    });
    await saveChain;
  };

  const flushPending = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (pendingRecords === 0) {
      return;
    }
    pendingRecords = 0;
    await queueMetadataWrite(false);
  };

  const persist = async (): Promise<void> => {
    if (concurrency === 1) {
      await queueMetadataWrite(true);
      return;
    }

    pendingRecords++;
    if (pendingRecords >= METADATA_BATCH_MAX_RECORDS) {
      void flushPending();
      return;
    }
    if (saveTimer) {
      return;
    }

    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void flushPending();
    }, METADATA_BATCH_INTERVAL_MS);
  };

  let aborted = false;
  const abortController = new AbortController();
  const fail = (error: unknown, printError = true): void => {
    if (aborted) return;
    aborted = true;
    abortController.abort();
    if (printError) {
      console.error(`\n${errorMessage(error)}`);
    }
    console.log(`Resume later with: --resume ${tmpDir}`);
    process.exitCode = 1;
  };

  if (map) {
    initPath = join(tmpDir, initFileName);

    if (!options.initValid || !track.initSegment) {
      let slice: number;
      try {
        slice = reserveBytes();
      } catch (error) {
        fail(error);
        return null;
      }

      console.log(`Downloading ${kindLabel}initialization segment...`);
      let settled = false;
      try {
        const partialPath = join(trackWorkDir, `${initFileName}.part`);
        const result = await downloadInitSegmentToFile(map, playlistUrl, partialPath, {
          network,
          keyCache,
          maxBytes: slice,
          container: 'fmp4',
          signal: abortController.signal,
          timeoutMs: options.timeoutMs,
          attempts: options.maxAttempts,
        });

        await replaceSegmentFile(partialPath, initPath);
        settleBytes(slice, result.size);
        settled = true;

        if (options.persist) {
          if (kind === 'audio') {
            recordAudioInitSegment(options.metadata, initFileName, result.size, result.sha256);
          } else {
            recordInitSegment(options.metadata, initFileName, result.size, result.sha256);
          }
          await persist();
        }

        currentBytes += result.size;
      } catch (error) {
        if (!settled) {
          releaseBytes(slice);
        }
        fail(saveError ?? error);
        return null;
      }
    }
  }

  const progress: TrackProgress =
    concurrency > 1
      ? new ParallelDownloadProgress(
          segments.length,
          currentBytes,
          options.completed.size,
          Boolean(stdin.isTTY),
          kind === 'audio' ? 'Audio ' : '',
        )
      : new DownloadProgress(
          segments.length,
          currentBytes,
          options.completed.size,
          Boolean(stdin.isTTY),
          kind === 'audio' ? 'Audio ' : '',
        );

  console.log(
    kind === 'audio'
      ? `Downloading audio: ${segments.length} segments...`
      : `Downloading ${segments.length} segments...`,
  );
  if (concurrency > 1) {
    console.log(`Using up to ${concurrency} parallel segment downloads.`);
  }

  const pendingIndices: number[] = [];
  for (let index = 0; index < segments.length; index++) {
    if (!options.completed.has(index)) {
      pendingIndices.push(index);
    }
  }
  let cursor = 0;

  const downloadOne = async (index: number): Promise<void> => {
    if (aborted) return;

    const segment = segments[index]!;
    const fileName = `${prefix}segment_${String(index).padStart(String(segments.length).length, '0')}.${extension}`;
    const segmentPath = join(tmpDir, fileName);

    if (index === 0 || index % 10 === 0) {
      try {
        await ensureFreeSpace(tmpDir, budget.maxSegmentBytes + FREE_SPACE_MARGIN, 'download');
      } catch (error) {
        fail(error);
        return;
      }
    }

    progress.startSegment(index, segment.byterange?.length);
    let attempts = 0;

    while (!aborted) {
      let slice: number;
      try {
        slice = reserveBytes();
      } catch (error) {
        fail(error);
        return;
      }

      let settled = false;
      try {
        const partialPath = join(trackWorkDir, `${fileName}.${attempts}.part`);
        let lastBytes = 0;
        const result = await downloadSegmentToFile(segment, playlistUrl, partialPath, {
          network,
          keyCache,
          maxBytes: slice,
          container,
          signal: abortController.signal,
          timeoutMs: options.timeoutMs,
          attempts: options.maxAttempts,
          onProgress: bytes => {
            if (concurrency > 1) {
              progress.addBytes(bytes - lastBytes);
              lastBytes = bytes;
            } else {
              progress.addBytes(bytes);
            }
          },
        });

        await replaceSegmentFile(partialPath, segmentPath);
        settleBytes(slice, result.size);
        settled = true;

        if (options.persist) {
          if (kind === 'audio') {
            recordAudioSegment(options.metadata, index, fileName, result.size, result.sha256);
          } else {
            recordSegment(options.metadata, index, fileName, result.size, result.sha256);
          }

          try {
            await persist();
          } catch (error) {
            fail(saveError ?? error);
            return;
          }
        }

        currentBytes += result.size;
        progress.completeSegment(result.size);
        return;
      } catch (error) {
        if (!settled) {
          releaseBytes(slice);
        }

        if (aborted) {
          return;
        }
        if (saveError) {
          fail(saveError);
          return;
        }
        if (
          error instanceof SegmentLimitError ||
          error instanceof DownloadLimitError ||
          error instanceof DiskSpaceError ||
          error instanceof UrlPolicyError
        ) {
          fail(error);
          return;
        }

        attempts++;
        console.error(`\nFailed to download ${kindLabel}segment ${index + 1}`);
        console.error(errorMessage(error));

        if (attempts >= options.maxAttempts) {
          console.error(`Max retries reached for ${kindLabel}segment ${index + 1}.`);
          fail(null, false);
          return;
        }

        if (concurrency === 1 && stdin.isTTY) {
          const action = await promptRetry(attempts, options.maxAttempts);
          if (action === 'save') {
            console.log(`Partial download saved. Resume later with: --resume ${tmpDir}`);
            process.exitCode = 1;
            aborted = true;
            abortController.abort();
            return;
          }
        } else {
          const wait = 500 * 2 ** (attempts - 1);
          console.error(`Retrying in ${wait}ms...`);
          await delay(wait);
        }
      }
    }
  };

  try {
    if (pendingIndices.length > 0) {
      const workerCount = Math.min(concurrency, pendingIndices.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (!aborted) {
          const index = pendingIndices[cursor++];
          if (index === undefined) {
            return;
          }
          await downloadOne(index);
        }
      });

      await Promise.all(workers);
    }

    await flushPending();
    await saveChain.catch(() => {});
    if (saveError) {
      fail(saveError, false);
      return null;
    }
    if (aborted) {
      return null;
    }

    const segmentPaths = segments.map((_, index) =>
      join(
        tmpDir,
        `${prefix}segment_${String(index).padStart(String(segments.length).length, '0')}.${extension}`,
      ),
    );

    return { segmentPaths, ...(initPath ? { initPath } : {}) };
  } finally {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    await flushPending();
    progress.finish();
    await rm(trackWorkDir, { recursive: true, force: true }).catch(() => {});
  }
}
const SUBTITLE_SEGMENT_MAX_BYTES = 16 * 1024 ** 2;

function renditionTag(rendition: M3U8Media): string {
  const raw = rendition.language || rendition.name || 'subs';
  const tag = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return tag || 'subs';
}

async function saveSubtitleSidecar(options: {
  segments: M3U8Segment[];
  playlistUrl: string;
  network: NetworkClient;
  outputPath: string;
  rendition: M3U8Media;
  force: boolean;
  retries: number;
  timeoutMs: number;
  maxSegmentBytes: number;
  budget: DownloadBudget;
}): Promise<void> {
  const texts: string[] = [];

  for (const segment of options.segments) {
    if (segment.byterange) {
      throw new Error('Byte-range subtitle segments are not supported');
    }

    const remaining =
      options.budget.maxBytes > 0
        ? options.budget.maxBytes - options.budget.usedBytes
        : Infinity;
    if (remaining <= 0) {
      throw new DownloadLimitError(
        `Download limit reached (${formatBytes(options.budget.maxBytes)}) while downloading subtitles.`,
      );
    }

    const maxBytes = Math.min(SUBTITLE_SEGMENT_MAX_BYTES, options.maxSegmentBytes, remaining);
    const url = resolveUrl(segment.uri, options.playlistUrl);
    const response = await options.network.fetch(url, {}, {
      attempts: options.retries,
      label: 'subtitle segment',
      timeoutMs: options.timeoutMs,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download subtitle segment: ${redactUrl(url)} (${response.status})`,
      );
    }

    const bytes = await readResponseBytes(response, maxBytes, 'Subtitle segment');
    const text = new TextDecoder().decode(bytes);
    if (!isValidWebVttSegment(text)) {
      throw new Error(`Downloaded subtitle segment is not valid WebVTT: ${redactUrl(url)}`);
    }

    options.budget.usedBytes += bytes.byteLength;
    texts.push(text);
  }

  const merged = mergeWebVttSegments(texts);
  if (!merged.trim()) {
    throw new Error('Subtitle playlist produced no cues');
  }

  const parsed = parsePath(options.outputPath);
  const sidecar = join(parsed.dir, `${parsed.name}.${renditionTag(options.rendition)}.vtt`);
  const target = pickAvailableOutputPath(sidecar, options.force);

  if (target.renamed) {
    console.log(`Subtitle file appeared; saving to: ${target.path}`);
  }

  const tempPath = join(parsed.dir, `.meow-subtitles-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, merged, { mode: 0o600 });
    await rename(tempPath, target.path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  console.log(`Subtitles saved to: ${target.path}`);
}

async function replaceFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    if (!isReplaceError(error)) {
      throw error;
    }
  }

  const backup = `${target}.meow-loader-backup-${process.pid}-${Date.now()}`;
  await rename(target, backup);

  try {
    await rename(source, target);
  } catch (error) {
    await rename(backup, target).catch(() => {});
    throw error;
  }

  await rm(backup, { force: true }).catch(() => {});
}

function isReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY';
}

async function cleanupWorkingDirectory(
  tmpDir: string,
  ownsTempDir: boolean,
  cleanupResumeDir: boolean,
  resume: ResumeState,
): Promise<void> {
  if (ownsTempDir) {
    await rm(tmpDir, { recursive: true, force: true });
    return;
  }

  if (cleanupResumeDir) {
    await cleanupResumeState(tmpDir, resume.metadata);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function registerInterruptHandlers(handler: (signal: NodeJS.Signals) => void): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => handler(signal));
  }
}

function createValidationReporter(): {
  onValidate: ResumeValidationCallback;
  finish: () => void;
} {
  let progress: ValidationProgress | undefined;

  return {
    onValidate: state => {
      if (!progress) {
        if (state.totalFiles < 3) {
          return;
        }
        progress = new ValidationProgress(
          state.totalFiles,
          state.totalBytes,
          Boolean(stdout.isTTY),
        );
      }
      progress.update(state.checkedFiles, state.checkedBytes);
    },
    finish: () => {
      progress?.finish();
      progress = undefined;
    },
  };
}

function resolveManifestUrl(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    throw new Error('Invalid playlist URL in manifest');
  }
}

function assertPlaylistBody(text: string): void {
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (!head.startsWith('<')) {
    return;
  }
  throw new Error(
    'The URL returned an HTML page instead of an M3U8 playlist. In the browser Network tab, copy the .m3u8 (or media) request instead of the page URL.',
  );
}

function estimateBytes(bandwidth: number, duration: number): number | undefined {
  if (!Number.isFinite(bandwidth) || bandwidth <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return undefined;
  }
  const estimate = (bandwidth / 8) * duration;
  return Number.isFinite(estimate) ? estimate : undefined;
}

function formatRendition(rendition: M3U8Media): string {
  const name = rendition.name || rendition.language || 'unnamed';
  const language = rendition.language ? ` (${sanitizeForDisplay(rendition.language, 40)})` : '';
  return `${sanitizeForDisplay(name, 80)}${language}`;
}

/**
 * Merge a saved working directory without contacting the playlist endpoint.
 * Used when the download finished but the merge failed, or when the endpoint
 * has gone away.
 */
async function mergeDownloadedSegments(args: ParsedArgs, mergeDir: string): Promise<void> {
  const [outputArg, ...extra] = args.positionals;
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${sanitizeForDisplay(extra[0]!, 80)}`);
  }

  const dir = await realpath(resolve(mergeDir)).catch(() => undefined);
  if (!dir) {
    throw new Error(`Merge directory does not exist: ${mergeDir}`);
  }

  const info = await lstat(dir).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`Merge path is not a directory: ${dir}`);
  }

  console.log(`Validating segments in: ${dir}`);
  const validation = createValidationReporter();
  let state: LoadedResumeState;
  try {
    state = await loadResumeState(dir, validation.onValidate);
  } finally {
    validation.finish();
  }
  const { metadata } = state;
  const container: HlsContainer = metadata.container ?? 'mpegts';

  const assertTrackComplete = (
    track: ResumeTrack,
    completed: Set<number>,
    initValid: boolean,
    label: string,
  ): void => {
    if (track.segmentCount === 0) {
      throw new Error(`No ${label}segments recorded in ${dir}`);
    }

    const trackContainer = track.container ?? 'mpegts';
    if (trackContainer === 'fmp4' && (!track.initSegment || !initValid)) {
      throw new Error(
        `Cannot merge ${dir}: the fMP4 ${label}initialization segment is missing or corrupt. Re-download with --resume ${dir} when the endpoint is available.`,
      );
    }

    const missing: number[] = [];
    for (let index = 0; index < track.segmentCount; index++) {
      if (!completed.has(index)) {
        missing.push(index);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Cannot merge ${dir}: ${missing.length} of ${track.segmentCount} ${label}segments are missing or corrupt (first missing index: ${missing[0]}). Re-download with --resume ${dir} when the endpoint is available.`,
      );
    }
  };

  assertTrackComplete(metadata, state.completed, state.initValid, '');

  const segmentPaths: string[] = [];
  let totalBytes = metadata.initSegment?.size ?? 0;
  for (let index = 0; index < metadata.segmentCount; index++) {
    const segment = metadata.segments[String(index)]!;
    segmentPaths.push(join(dir, segment.fileName));
    totalBytes += segment.size;
  }
  const initPath = metadata.initSegment ? join(dir, metadata.initSegment.fileName) : undefined;

  let audioPaths: string[] | undefined;
  let audioContainer: HlsContainer | undefined;
  if (metadata.audio) {
    if (!state.audio) {
      throw new Error('Resume state is missing the audio track');
    }

    assertTrackComplete(metadata.audio, state.audio.completed, state.audio.initValid, 'audio ');

    const audioTrack = metadata.audio;
    const paths: string[] = [];
    let audioBytes = audioTrack.initSegment?.size ?? 0;
    for (let index = 0; index < audioTrack.segmentCount; index++) {
      const segment = audioTrack.segments[String(index)]!;
      paths.push(join(dir, segment.fileName));
      audioBytes += segment.size;
    }
    if (audioTrack.initSegment) {
      paths.unshift(join(dir, audioTrack.initSegment.fileName));
    }

    totalBytes += audioBytes;
    audioPaths = paths;
    audioContainer = audioTrack.container ?? 'mpegts';
  }

  if (args.dryRun) {
    console.log(`Segments: ${metadata.segmentCount}`);
    console.log(`Container: ${container === 'fmp4' ? 'fMP4' : 'MPEG-TS'}`);
    if (metadata.audio) {
      console.log(`Audio segments: ${metadata.audio.segmentCount}`);
      console.log(
        `Audio container: ${(metadata.audio.container ?? 'mpegts') === 'fmp4' ? 'fMP4' : 'MPEG-TS'}`,
      );
    }
    if (metadata.durationSeconds !== undefined) {
      console.log(`Duration: ${formatDuration(metadata.durationSeconds)}`);
    }
    console.log(`Total size: ${formatBytes(totalBytes)}`);
    return;
  }

  await checkFfmpeg();
  const output = await resolveOutputPath(outputArg, args.force);
  const mergeCopies = audioPaths ? 2 : 1;
  await ensureFreeSpace(
    dirname(output),
    totalBytes * mergeCopies + Math.max(FREE_SPACE_MARGIN, totalBytes * 0.05),
    'merge',
  );

  let outputTempDir: string | undefined = await mkdtemp(join(dirname(output), '.meow-loader-'));
  const partialOutput = join(outputTempDir, basename(output));

  registerInterruptHandlers(signal => {
    abortActiveMerge();
    if (outputTempDir) {
      rmSync(outputTempDir, { recursive: true, force: true });
    }
    console.error(`\nInterrupted. Segments preserved at: ${dir}`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });

  console.log(`Merging ${formatBytes(totalBytes)} from ${metadata.segmentCount} segments...`);
  const mergePaths = initPath ? [initPath, ...segmentPaths] : segmentPaths;
  try {
    if (audioPaths && audioContainer) {
      const videoTemp = join(outputTempDir, 'video.mp4');
      const audioTemp = join(outputTempDir, 'audio.mp4');

      await mergeToMp4(mergePaths, videoTemp, { container });
      await mergeToMp4(audioPaths, audioTemp, { container: audioContainer });
      await muxToMp4(videoTemp, audioTemp, partialOutput);
    } else {
      await mergeToMp4(mergePaths, partialOutput, { container });
    }

    console.log('Verifying output...');
    await validateMp4Output(partialOutput, metadata.durationSeconds);
    await assertOutputAvailable(output, args.force);
    await replaceFile(partialOutput, output);
  } catch (error) {
    throw new Error(
      `Failed to finalize output: ${errorMessage(error)}\nSegments preserved at: ${dir}`,
    );
  } finally {
    await rm(outputTempDir, { recursive: true, force: true }).catch(() => {});
    outputTempDir = undefined;
  }
  if (args.cleanup) {
    try {
      await cleanupResumeState(dir, metadata);
    } catch (error) {
      console.warn(`Warning: failed to clean up ${dir}: ${errorMessage(error)}`);
    }
  }

  console.log(`Done! Saved to: ${output}`);
  if (!args.cleanup) {
    console.log(`Segments kept at: ${dir}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    return;
  }
  if (args.version) {
    console.log(getVersion());
    return;
  }
  if (args.cleanup && !args.resumeDir && !args.mergeDir) {
    throw new Error('--cleanup requires --resume or --merge-only');
  }
  if (args.mergeDir && args.resumeDir) {
    throw new Error('--merge-only cannot be combined with --resume');
  }
  if (
    args.mergeDir &&
    (args.audio !== undefined || args.audioLanguage !== undefined || args.subtitle !== undefined)
  ) {
    throw new Error('--audio, --audio-language, and --subtitle cannot be used with --merge-only');
  }
  if (args.maxSegmentSize <= 0) {
    throw new Error('--max-segment-size must be greater than 0');
  }

  if (args.mergeDir) {
    await mergeDownloadedSegments(args, args.mergeDir);
    return;
  }

  const [url, outputArg, variantArg, ...extra] = args.positionals;
  if (!url) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${sanitizeForDisplay(extra[0]!, 80)}`);
  }

  const network = new NetworkClient({
    playlistUrl: url,
    userHeaders: args.headers,
    headerOrigins: args.headerOrigins,
    allowPrivateNetwork: args.allowPrivateNetwork,
    allowInsecure: args.allowInsecure,
    timeoutMs: args.timeoutMs,
  });

  console.log(`Fetching playlist: ${redactUrl(url)}`);
  const response = await network.fetch(url, {}, { attempts: args.retries, label: 'playlist' });
  if (!response.ok) {
    throw new Error(`Failed to fetch playlist: ${response.status}`);
  }

  const masterUrl = response.url || url;
  const playlistBody = await readResponseText(response, DEFAULT_PLAYLIST_MAX_BYTES);
  assertPlaylistBody(playlistBody);
  let playlist = parseM3U8(playlistBody);
  let playlistUrl = masterUrl;
  let selectedVariant: M3U8Variant | undefined;

  let audioRendition: M3U8Media | undefined;
  let subtitleRendition: M3U8Media | undefined;

  if (playlist.isMaster) {
    if (!playlist.variants || playlist.variants.length === 0) {
      throw new Error('Master playlist contains no variants');
    }
    if (playlist.variants.length > MAX_VARIANTS) {
      throw new Error(`Master playlist has too many variants (${playlist.variants.length})`);
    }

    const masterPlaylist = playlist;
    selectedVariant = await selectVariant(masterPlaylist.variants!, variantArg);

    if (
      selectedVariant.audioGroup &&
      masterPlaylist.separateAudioGroups.includes(selectedVariant.audioGroup)
    ) {
      audioRendition = await selectRenditionForGroup({
        media: masterPlaylist.media,
        groupId: selectedVariant.audioGroup,
        type: 'AUDIO',
        indexArg: args.audio,
        languageArg: args.audioLanguage,
        label: 'audio',
        flagName: args.audio !== undefined ? '--audio' : '--audio-language',
        parseIndex: parseAudioIndex,
      });
      if (audioRendition) {
        console.log(`Audio rendition: ${formatRendition(audioRendition)}`);
      }
    } else if (args.audio !== undefined || args.audioLanguage !== undefined) {
      const flag = args.audio !== undefined ? '--audio' : '--audio-language';
      throw new Error(`${flag} requires a master playlist with a separate audio rendition`);
    }

    if (selectedVariant.subtitleGroup) {
      subtitleRendition = await selectRenditionForGroup({
        media: masterPlaylist.media,
        groupId: selectedVariant.subtitleGroup,
        type: 'SUBTITLES',
        indexArg: args.subtitle,
        label: 'subtitle',
        flagName: '--subtitle',
        parseIndex: parseSubtitleIndex,
      });
      if (subtitleRendition) {
        console.log(`Subtitle rendition: ${formatRendition(subtitleRendition)}`);
      }
    } else if (args.subtitle !== undefined) {
      throw new Error('--subtitle requires a master playlist with a separate subtitle rendition');
    }

    playlistUrl = resolveManifestUrl(selectedVariant.uri, masterUrl);

    console.log(
      `Selected variant: ${sanitizeForDisplay(selectedVariant.resolution || 'unknown', 80)} @ ${selectedVariant.bandwidth / 1000} kbps`,
    );
    console.log(`Fetching variant playlist: ${redactUrl(playlistUrl)}`);

    const variantResponse = await network.fetch(playlistUrl, {}, { attempts: args.retries, label: 'variant playlist' });
    if (!variantResponse.ok) {
      throw new Error(`Failed to fetch variant playlist: ${variantResponse.status}`);
    }

    playlistUrl = variantResponse.url || playlistUrl;
    const variantBody = await readResponseText(variantResponse, DEFAULT_PLAYLIST_MAX_BYTES);
    assertPlaylistBody(variantBody);
    playlist = parseM3U8(variantBody);
  } else if (variantArg !== undefined) {
    throw new Error('variant-index can only be used with a master playlist');
  } else if (
    args.audio !== undefined ||
    args.audioLanguage !== undefined ||
    args.subtitle !== undefined
  ) {
    const flag =
      args.subtitle !== undefined
        ? '--subtitle'
        : args.audio !== undefined
          ? '--audio'
          : '--audio-language';
    throw new Error(`${flag} can only be used with a master playlist`);
  }

  const expectedDuration = validateMediaPlaylist(playlist);
  const segments = playlist.segments!;
  const container: HlsContainer = playlist.map ? 'fmp4' : 'mpegts';
  const map = playlist.map;

  let audioPlaylistUrl = audioRendition?.uri
    ? resolveManifestUrl(audioRendition.uri, masterUrl)
    : undefined;
  let audioSegments: M3U8Segment[] | undefined;
  let audioContainer: HlsContainer | undefined;
  let audioMap: M3U8Map | undefined;
  let audioDuration: number | undefined;

  if (audioPlaylistUrl) {
    console.log(`Fetching audio playlist: ${redactUrl(audioPlaylistUrl)}`);
    const audioResponse = await network.fetch(audioPlaylistUrl, {}, {
      attempts: args.retries,
      label: 'audio playlist',
    });
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio playlist: ${audioResponse.status}`);
    }

    audioPlaylistUrl = audioResponse.url || audioPlaylistUrl;
    const audioBody = await readResponseText(audioResponse, DEFAULT_PLAYLIST_MAX_BYTES);
    assertPlaylistBody(audioBody);
    const audioPlaylist = parseM3U8(audioBody);
    if (audioPlaylist.isMaster) {
      throw new Error('The audio rendition points to another master playlist');
    }

    audioDuration = validateMediaPlaylist(audioPlaylist);
    audioSegments = audioPlaylist.segments!;
    audioContainer = audioPlaylist.map ? 'fmp4' : 'mpegts';
    audioMap = audioPlaylist.map;

    if (Math.abs(audioDuration - expectedDuration) > Math.max(2, expectedDuration * 0.02)) {
      console.warn(
        `Warning: audio duration ${formatDuration(audioDuration)} differs from video duration ${formatDuration(expectedDuration)}`,
      );
    }
  }

  let subtitlePlaylistUrl = subtitleRendition?.uri
    ? resolveManifestUrl(subtitleRendition.uri, masterUrl)
    : undefined;
  let subtitleSegments: M3U8Segment[] | undefined;

  if (subtitlePlaylistUrl) {
    try {
      console.log(`Fetching subtitle playlist: ${redactUrl(subtitlePlaylistUrl)}`);
      const subtitleResponse = await network.fetch(subtitlePlaylistUrl, {}, {
        attempts: args.retries,
        label: 'subtitle playlist',
      });
      if (!subtitleResponse.ok) {
        throw new Error(`Failed to fetch subtitle playlist: ${subtitleResponse.status}`);
      }

      subtitlePlaylistUrl = subtitleResponse.url || subtitlePlaylistUrl;
      const subtitleBody = await readResponseText(subtitleResponse, DEFAULT_PLAYLIST_MAX_BYTES);
      assertPlaylistBody(subtitleBody);
      const subtitlePlaylist = parseM3U8(subtitleBody);
      if (subtitlePlaylist.isMaster) {
        throw new Error('The subtitle rendition points to another master playlist');
      }

      validateMediaPlaylist(subtitlePlaylist);
      subtitleSegments = subtitlePlaylist.segments!;
      if (subtitleSegments.some(segment => segment.encryption)) {
        throw new Error('Encrypted subtitle segments are not supported');
      }

      console.log(`Subtitle segments: ${subtitleSegments.length}`);
    } catch (error) {
      if (args.subtitle !== undefined) {
        throw error;
      }
      console.warn(`Warning: skipping subtitles: ${errorMessage(error)}`);
      subtitleRendition = undefined;
      subtitlePlaylistUrl = undefined;
      subtitleSegments = undefined;
    }
  }

  const estimatedBytes = selectedVariant
    ? estimateBytes(selectedVariant.bandwidth, expectedDuration)
    : undefined;

  if (args.dryRun) {
    console.log(`Segments: ${segments.length}`);
    console.log(`Container: ${container === 'fmp4' ? 'fMP4' : 'MPEG-TS'}`);
    console.log(`Duration: ${formatDuration(expectedDuration)}`);
    if (audioSegments && audioContainer) {
      console.log(`Audio segments: ${audioSegments.length}`);
      console.log(`Audio container: ${audioContainer === 'fmp4' ? 'fMP4' : 'MPEG-TS'}`);
      if (audioDuration !== undefined) {
        console.log(`Audio duration: ${formatDuration(audioDuration)}`);
      }
    }
    if (subtitleSegments) {
      console.log(`Subtitle segments: ${subtitleSegments.length}`);
      if (subtitleRendition?.language) {
        console.log(`Subtitle language: ${sanitizeForDisplay(subtitleRendition.language, 40)}`);
      }
    }
    if (estimatedBytes !== undefined) {
      console.log(`Estimated size: ~${formatBytes(estimatedBytes)} (bandwidth-based)`);
    }
    if (args.maxDownload > 0) {
      console.log(`Download limit: ${formatBytes(args.maxDownload)}`);
    }
    const free = await getFreeBytes(process.cwd());
    if (free !== undefined) {
      console.log(`Free space: ${formatBytes(free)}`);
    }
    return;
  }

  await checkFfmpeg();
  const output = await resolveOutputPath(outputArg, args.force);

  let maxDownload = args.maxDownload;
  if (estimatedBytes !== undefined && maxDownload > 0 && estimatedBytes > maxDownload) {
    if (await promptLargeDownload(estimatedBytes, maxDownload)) {
      maxDownload = Math.ceil(estimatedBytes * 1.25);
      console.log(`Continuing with a limit of ${formatBytes(maxDownload)} for this run.`);
    } else {
      throw new DownloadLimitError(
        `Estimated download is ${formatBytes(estimatedBytes)}, above the ${formatBytes(maxDownload)} limit. Use --max-download to raise it.`,
      );
    }
  }

  const { tmpDir, ownsTempDir, workDir } = await prepareWorkingDirectory(args.resumeDir);

  if (estimatedBytes !== undefined) {
    await ensureFreeSpace(tmpDir, estimatedBytes + FREE_SPACE_MARGIN, 'download');
  }

  const validation = createValidationReporter();
  let resume: ResumeState;
  try {
    resume = await initializeResumeState({
      dir: tmpDir,
      sourceUrl: url,
      persist: true,
      tempDir: workDir,
      video: { mediaPlaylistUrl: playlistUrl, segments, container, map },
      ...(audioSegments && audioContainer && audioPlaylistUrl
        ? {
            audio: {
              mediaPlaylistUrl: audioPlaylistUrl,
              segments: audioSegments,
              container: audioContainer,
              map: audioMap,
            },
          }
        : {}),
      onValidate: validation.onValidate,
    });
  } finally {
    validation.finish();
  }

  console.log(`Working dir: ${tmpDir}`);
  if (resume.completed.size > 0) {
    console.log(`Resuming with ${resume.completed.size}/${segments.length} segments already downloaded`);
  }
  if (resume.audio && resume.audio.completed.size > 0 && audioSegments) {
    console.log(
      `Resuming with ${resume.audio.completed.size}/${audioSegments.length} audio segments already downloaded`,
    );
  }

  let outputTempDir: string | undefined;

  registerInterruptHandlers(signal => {
    abortActiveMerge();
    rmSync(workDir, { recursive: true, force: true });
    if (outputTempDir) {
      rmSync(outputTempDir, { recursive: true, force: true });
    }
    console.error(`\nInterrupted. Resume later with: --resume ${tmpDir}`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });

  const keyCache = new Map<string, Buffer>();
  const budget: DownloadBudget = {
    usedBytes:
      trackBytes(resume.metadata) +
      (resume.metadata.audio ? trackBytes(resume.metadata.audio) : 0),
    maxBytes: maxDownload,
    maxSegmentBytes: args.maxSegmentSize,
  };

  const videoResult = await downloadTrack({
    kind: 'video',
    segments,
    playlistUrl,
    container,
    map,
    tmpDir,
    workDir,
    network,
    keyCache,
    metadata: resume.metadata,
    completed: resume.completed,
    initValid: resume.initValid,
    persist: true,
    budget,
    concurrency: args.concurrency,
    maxAttempts: args.retries,
    timeoutMs: args.timeoutMs,
  });
  if (!videoResult) {
    return;
  }

  let audioResult: DownloadedTrack | undefined;
  if (audioSegments && audioContainer && audioPlaylistUrl) {
    if (!resume.audio) {
      throw new Error('Resume state is missing the audio track');
    }

    const result = await downloadTrack({
      kind: 'audio',
      segments: audioSegments,
      playlistUrl: audioPlaylistUrl,
      container: audioContainer,
      map: audioMap,
      tmpDir,
      workDir,
      network,
      keyCache,
      metadata: resume.metadata,
      completed: resume.audio.completed,
      initValid: resume.audio.initValid,
      persist: true,
      budget,
      concurrency: args.concurrency,
      maxAttempts: args.retries,
      timeoutMs: args.timeoutMs,
    });
    if (!result) {
      return;
    }
    audioResult = result;
  }

  const totalBytes = budget.usedBytes;
  const finalOutput = pickAvailableOutputPath(output, args.force);
  if (finalOutput.renamed) {
    console.log(`Output appeared during the download; saving to: ${finalOutput.path}`);
  }

  await assertOutputAvailable(finalOutput.path, args.force);
  const mergeCopies = audioResult ? 2 : 1;
  await ensureFreeSpace(
    dirname(finalOutput.path),
    totalBytes * mergeCopies + Math.max(FREE_SPACE_MARGIN, totalBytes * 0.05),
    'merge',
  );

  outputTempDir = await mkdtemp(join(dirname(finalOutput.path), '.meow-loader-'));
  const partialOutput = join(outputTempDir, basename(finalOutput.path));

  console.log(`\nMerging ${formatBytes(totalBytes)} into MP4...`);
  const videoPaths = videoResult.initPath
    ? [videoResult.initPath, ...videoResult.segmentPaths]
    : videoResult.segmentPaths;
  try {
    if (audioResult && audioContainer) {
      const audioPaths = audioResult.initPath
        ? [audioResult.initPath, ...audioResult.segmentPaths]
        : audioResult.segmentPaths;
      const videoTemp = join(outputTempDir, 'video.mp4');
      const audioTemp = join(outputTempDir, 'audio.mp4');

      await mergeToMp4(videoPaths, videoTemp, { container });
      await mergeToMp4(audioPaths, audioTemp, { container: audioContainer });
      await muxToMp4(videoTemp, audioTemp, partialOutput);
    } else {
      await mergeToMp4(videoPaths, partialOutput, { container });
    }

    console.log('Verifying output...');
    await validateMp4Output(partialOutput, expectedDuration);
    await assertOutputAvailable(finalOutput.path, args.force);
    await replaceFile(partialOutput, finalOutput.path);
  } catch (error) {
    throw new Error(
      `Failed to finalize output: ${errorMessage(error)}\nSegments preserved at: ${tmpDir}\nResume later with: --resume ${tmpDir}`,
    );
  } finally {
    await rm(outputTempDir, { recursive: true, force: true }).catch(() => {});
    outputTempDir = undefined;
  }

  if (subtitleSegments && subtitlePlaylistUrl && subtitleRendition) {
    try {
      await saveSubtitleSidecar({
        segments: subtitleSegments,
        playlistUrl: subtitlePlaylistUrl,
        network,
        outputPath: finalOutput.path,
        rendition: subtitleRendition,
        force: args.force,
        retries: args.retries,
        timeoutMs: args.timeoutMs,
        maxSegmentBytes: args.maxSegmentSize,
        budget,
      });
    } catch (error) {
      if (args.subtitle !== undefined) {
        throw new Error(`Failed to save subtitles: ${errorMessage(error)}`);
      }
      console.warn(`Warning: failed to save subtitles: ${errorMessage(error)}`);
    }
  }
  try {
    await cleanupWorkingDirectory(tmpDir, ownsTempDir, args.cleanup, resume);
  } catch (error) {
    console.warn(`Warning: failed to clean up ${tmpDir}: ${errorMessage(error)}`);
  }

  console.log(`Done! Saved to: ${finalOutput.path}`);
  if (!ownsTempDir && !args.cleanup) {
    console.log(`Segments kept at: ${tmpDir}`);
  }
}

function errorMessage(error: unknown): string {
  return sanitizeMultiline(error instanceof Error ? error.message : String(error));
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
