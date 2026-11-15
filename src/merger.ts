import { copyFile, link, mkdir, writeFile, unlink, rm, mkdtemp } from 'node:fs/promises';
import { createReadStream, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import type { HlsContainer } from './segment-validation';

let activeFfmpeg: ChildProcess | undefined;
let activeMergeTempDir: string | undefined;

export function abortActiveMerge(): void {
  activeFfmpeg?.kill('SIGTERM');
  activeFfmpeg = undefined;

  if (activeMergeTempDir) {
    rmSync(activeMergeTempDir, { recursive: true, force: true });
    activeMergeTempDir = undefined;
  }
}

export interface MergeOptions {
  /**
   * MPEG-TS is joined with the ffmpeg concat demuxer and needs the
   * aac_adtstoasc bitstream filter. fMP4 fragments are byte-concatenated
   * through ffmpeg stdin instead.
   */
  container?: HlsContainer;
}

export async function mergeToMp4(
  segmentPaths: string[],
  outputPath: string,
  options: MergeOptions = {},
): Promise<void> {
  if (segmentPaths.length === 0) {
    throw new Error('No segments to merge');
  }

  if (options.container === 'fmp4') {
    await mergeFmp4(segmentPaths, outputPath);
    return;
  }

  const inputRoot = dirname(segmentPaths[0]!);
  const tmpDir = await mkdtemp(join(inputRoot, '.meow-merge-'));
  activeMergeTempDir = tmpDir;

  const inputDir = join(tmpDir, 'input');
  const concatList = join(inputDir, 'concat.txt');

  try {
    await mkdir(inputDir, { recursive: true });
    // Use generated names and relative paths so no user/manifest-controlled
    // path ever reaches the ffmpeg concat list.
    const lines: string[] = [];
    for (let index = 0; index < segmentPaths.length; index++) {
      const target = join(inputDir, `${index}.ts`);
      try {
        await link(segmentPaths[index]!, target);
      } catch {
        await copyFile(segmentPaths[index]!, target);
      }
      lines.push(`file '${escapeConcatPath(`${index}.ts`)}'`);
    }

    await writeFile(concatList, lines.join('\n') + '\n');

    try {
      await runFfmpeg(['-i', concatList, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outputPath]);
    } catch (firstError) {
      try {
        await runFfmpeg(['-i', concatList, '-c', 'copy', outputPath]);
      } catch (secondError) {
        throw new Error(
          `ffmpeg failed.\nFirst attempt: ${errorMessage(firstError)}\nSecond attempt: ${errorMessage(secondError)}`,
        );
      }
    }
  } finally {
    try {
      await unlink(concatList);
    } catch {}
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {}
    if (activeMergeTempDir === tmpDir) {
      activeMergeTempDir = undefined;
    }
  }
}

/**
 * fMP4 fragments are not standalone inputs for the concat demuxer. Feed the
 * initialization segment followed by the media fragments to ffmpeg over stdin
 * and remux the concatenated stream into a regular MP4.
 */
async function mergeFmp4(segmentPaths: string[], outputPath: string): Promise<void> {
  const proc = spawn(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-y', '-i', 'pipe:0', '-c', 'copy', outputPath],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  activeFfmpeg = proc;

  let stderr = '';
  let spawnError: Error | undefined;
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_000);
  });

  const closed = new Promise<number | null>((resolve) => {
    proc.on('close', (code) => {
      if (activeFfmpeg === proc) {
        activeFfmpeg = undefined;
      }
      resolve(code);
    });
    proc.on('error', (error) => {
      if (activeFfmpeg === proc) {
        activeFfmpeg = undefined;
      }
      spawnError = error;
      resolve(null);
    });
  });

  try {
    for (const path of segmentPaths) {
      await pipeline(createReadStream(path), proc.stdin!, { end: false });
    }
    proc.stdin!.end();
  } catch (error) {
    proc.kill('SIGTERM');
    await closed;
    const cause = spawnError ?? error;
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('ffmpeg not found. Please install ffmpeg and ensure it is in your PATH.');
    }
    const detail = stderr.trim();
    throw new Error(`${errorMessage(cause)}${detail ? `\n${detail}` : ''}`);
  }

  const code = await closed;
  if (spawnError) {
    if ((spawnError as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('ffmpeg not found. Please install ffmpeg and ensure it is in your PATH.');
    }
    throw spawnError;
  }
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  }
}

export async function muxToMp4(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
  await runFfmpegProcess([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    outputPath,
  ]);
}

function runFfmpeg(args: string[]): Promise<void> {
  return runFfmpegProcess([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'concat',
    '-safe',
    '1',
    '-protocol_whitelist',
    'file,pipe',
    ...args,
  ]);
}

function runFfmpegProcess(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    activeFfmpeg = proc;

    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      // Consume stderr so ffmpeg cannot block on a full pipe. Keep only the
      // tail for the error message.
      stderr = (stderr + chunk).slice(-16_000);
    });

    proc.on('close', (code) => {
      if (activeFfmpeg === proc) {
        activeFfmpeg = undefined;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
      }
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (activeFfmpeg === proc) {
        activeFfmpeg = undefined;
      }
      if (err.code === 'ENOENT') {
        reject(new Error('ffmpeg not found. Please install ffmpeg and ensure it is in your PATH.'));
      } else {
        reject(err);
      }
    });
  });
}

export function escapeConcatPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
