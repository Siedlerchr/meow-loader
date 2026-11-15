import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadResumeState } from '../src/resume';

function metadata(segmentCount: number): Record<string, unknown> {
  return {
    version: 2,
    sourceUrlHash: 'a'.repeat(64),
    sourceDisplay: 'https://example.com/',
    mediaPlaylistUrlHash: 'b'.repeat(64),
    mediaPlaylistUrlDisplay: 'https://example.com/media.m3u8',
    segmentCount,
    segmentFingerprint: 'c'.repeat(64),
    segments: {},
  };
}

describe('resume metadata safety', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meow-resume-security-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects an absurd segment count before allocating', async () => {
    await writeFile(
      join(dir, 'meow-loader.resume.json'),
      JSON.stringify(metadata(2_000_000_000)),
    );

    await expect(loadResumeState(dir)).rejects.toThrow('Invalid or outdated resume metadata');
  });

  it('rejects non-canonical segment keys', async () => {
    const data = metadata(1);
    data.segments = {
      '00': { fileName: 'segment_0.ts', size: 1, sha256: 'd'.repeat(64) },
    };
    await writeFile(join(dir, 'meow-loader.resume.json'), JSON.stringify(data));

    await expect(loadResumeState(dir)).rejects.toThrow('Invalid or outdated resume metadata');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked metadata file', async () => {
    const real = join(dir, 'real-metadata.json');
    await writeFile(real, JSON.stringify(metadata(0)));
    await symlink(real, join(dir, 'meow-loader.resume.json'));

    await expect(loadResumeState(dir)).rejects.toThrow('must be a regular file');
  });

  it('rejects a directory in place of the metadata file', async () => {
    await (await import('node:fs/promises')).mkdir(join(dir, 'meow-loader.resume.json'));

    await expect(loadResumeState(dir)).rejects.toThrow('must be a regular file');
  });
});
