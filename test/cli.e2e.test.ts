import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distEntry = join(root, 'dist', 'index.mjs');
const fixtures = join(root, 'test', 'fixtures');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const canRun = hasFfmpeg && hasFfprobe && existsSync(distEntry);

const mediaPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.000,
segments/segment_000_red.ts
#EXTINF:10.000,
segments/segment_001_blue.ts
#EXTINF:10.000,
segments/segment_002_green.ts
#EXT-X-ENDLIST
`;

const masterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=480x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
high.m3u8
`;

const livePlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10,
segments/segment_000_red.ts
`;

const fmp4Playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="fmp4/init.mp4"
#EXTINF:2.000000,
fmp4/segment_0.m4s
#EXTINF:2.000000,
fmp4/segment_1.m4s
#EXTINF:2.000000,
fmp4/segment_2.m4s
#EXT-X-ENDLIST
`;

const badFmp4Playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="fmp4-bad/init.mp4"
#EXTINF:2.000000,
fmp4/segment_0.m4s
#EXT-X-ENDLIST
`;

const queryMasterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
query-media.m3u8?quality=high
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=480x360
query-media.m3u8?quality=low
`;

const corruptPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10,
segments/segment_000_red.ts
#EXTINF:10,
segments/corrupt.html
#EXTINF:10,
segments/segment_002_green.ts
#EXT-X-ENDLIST
`;

const truncatedPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10,
segments/segment_000_red.ts
#EXTINF:10,
segments/truncated.ts
#EXTINF:10,
segments/segment_002_green.ts
#EXT-X-ENDLIST
`;

const unsortedMasterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=480x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=720x480
medium.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
high.m3u8
`;

describe.skipIf(!canRun)('CLI end-to-end', () => {
  let server: Server;
  let baseUrl: string;
  let tempRoot: string;
  let segmentRequests: string[] = [];
  let segmentGate: { path: string; started: () => void; released: Promise<void> } | undefined;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'meow-loader-e2e-'));
    server = createServer(async (request, response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;

      if (pathname === '/nested/redirect.m3u8') {
        response.writeHead(302, { location: '/other/media.m3u8' });
        response.end();
        return;
      }

      if (pathname === '/live.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(livePlaylist);
        return;
      }

      if (pathname === '/fmp4.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(fmp4Playlist);
        return;
      }

      if (pathname === '/fmp4-bad.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(badFmp4Playlist);
        return;
      }

      if (pathname === '/fmp4-bad/init.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4' });
        response.end('<html><body>not an initialization segment</body></html>');
        return;
      }

      if (pathname.startsWith('/fmp4/')) {
        const fileName = pathname.split('/').pop()!;
        try {
          const content = await readFile(join(fixtures, 'fmp4', fileName));
          response.writeHead(200, {
            'content-type': fileName.endsWith('.m4s') ? 'video/iso.segment' : 'video/mp4',
          });
          response.end(content);
        } catch {
          response.writeHead(404);
          response.end('not found');
        }
        return;
      }

      if (pathname === '/headers.m3u8') {
        if (request.headers['user-agent'] !== 'custom-agent' || request.headers['x-test-header'] !== 'yes') {
          response.writeHead(401);
          response.end('missing headers');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(mediaPlaylist);
        return;
      }

      if (pathname === '/curl.m3u8') {
        if (request.headers.cookie !== 'session=abc123' || request.headers.pragma !== 'no-cache') {
          response.writeHead(403);
          response.end('missing cookie or pragma');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(mediaPlaylist);
        return;
      }

      if (pathname === '/page') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><html><body>player</body></html>');
        return;
      }

      if (pathname === '/query-master.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(queryMasterPlaylist);
        return;
      }

      if (pathname === '/query-media.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(mediaPlaylist);
        return;
      }

      if (pathname === '/corrupt.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(corruptPlaylist);
        return;
      }

      if (pathname === '/truncated.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(truncatedPlaylist);
        return;
      }

      if (pathname === '/other/media.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(mediaPlaylist);
        return;
      }

      if (pathname === '/master.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(masterPlaylist);
        return;
      }

      if (pathname === '/unsorted.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(unsortedMasterPlaylist);
        return;
      }

      if (
        pathname === '/media.m3u8' ||
        pathname === '/low.m3u8' ||
        pathname === '/medium.m3u8' ||
        pathname === '/high.m3u8'
      ) {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end(mediaPlaylist);
        return;
      }

      if (pathname.startsWith('/segments/') || pathname.startsWith('/other/segments/')) {
        segmentRequests.push(pathname);
        if (segmentGate?.path === pathname) {
          segmentGate.started();
          await segmentGate.released;
        }
        const fileName = pathname.split('/').pop()!;

        if (fileName === 'corrupt.html') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<html><body>error</body></html>');
          return;
        }

        try {
          const sourceName = fileName === 'truncated.ts' ? 'segment_001_blue.ts' : fileName;
          let content = await readFile(join(fixtures, 'segments', sourceName));
          if (fileName === 'truncated.ts') {
            content = content.subarray(0, 188 * 10);
          }
          response.writeHead(200, { 'content-type': 'video/mp2t' });
          response.end(content);
        } catch {
          response.writeHead(404);
          response.end('not found');
        }
        return;
      }

      response.writeHead(404);
      response.end('not found');
    });

    await new Promise<void>((resolveListening) => {
      server.listen(0, '127.0.0.1', () => resolveListening());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, reject) => {
      server.close(error => (error ? reject(error) : resolveClose()));
    });
    await rm(tempRoot, { recursive: true, force: true });
  });

  function command(args: string[]) {
    return commandBare([...args, '--allow-private-network']);
  }

  function commandBare(args: string[]) {
    return execFileAsync(process.execPath, [distEntry, ...args], {
      cwd: tempRoot,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  it('downloads and merges a media playlist', async () => {
    segmentRequests = [];
    const output = join(tempRoot, 'media.mp4');

    const { stdout } = await command([`${baseUrl}/media.m3u8`, output]);

    expect(stdout).toContain('Segment 1/3');
    expect(stdout).toContain('Done! Saved to');
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
    expect(segmentRequests).toHaveLength(3);
  });

  it('uses the next free filename when the output appears during download', async () => {
    const output = join(tempRoot, 'appeared.mp4');
    let markStarted!: () => void;
    let releaseSegment!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const released = new Promise<void>(resolve => {
      releaseSegment = resolve;
    });
    segmentGate = { path: '/segments/segment_001_blue.ts', started: markStarted, released };

    const child = spawn(
      process.execPath,
      [distEntry, `${baseUrl}/media.m3u8`, output, '--allow-private-network'],
      { cwd: tempRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    const closed = new Promise<number | null>(resolve => {
      child.on('close', resolve);
    });

    try {
      await started;
      // Simulate another process creating the requested filename mid-download.
      await writeFile(output, 'created by another process');
      releaseSegment();

      const code = await closed;
      expect(code, stderr).toBe(0);
      expect(await readFile(output, 'utf8')).toBe('created by another process');
      expect(existsSync(join(tempRoot, 'appeared-1.mp4'))).toBe(true);
      expect(stdout).toContain('Output appeared during the download');
    } finally {
      releaseSegment();
      segmentGate = undefined;
    }
  });

  it('downloads from a pasted Copy as cURL command', async () => {
    segmentRequests = [];
    const output = join(tempRoot, 'curl.mp4');

    const { stdout } = await command([
      'curl',
      `${baseUrl}/curl.m3u8`,
      '-H',
      'Pragma: no-cache',
      '-H',
      'Connection: keep-alive',
      '-b',
      'session=abc123',
      '--compressed',
      '-o',
      output,
    ]);

    expect(stdout).toContain('Done! Saved to');
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
    expect(segmentRequests).toHaveLength(3);
  });

  it('explains that an HTML page is not a playlist', async () => {
    const error = await command([`${baseUrl}/page`]).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('HTML page instead of an M3U8 playlist');
  });

  it('prints playlist information without downloading in --dry-run mode', async () => {
    segmentRequests = [];

    const { stdout } = await command([`${baseUrl}/unsorted.m3u8`, '--dry-run']);

    expect(stdout).toContain('Segments: 3');
    expect(stdout).toContain('Duration:');
    expect(stdout).toContain('Estimated size:');
    expect(segmentRequests).toHaveLength(0);
  });

  it('blocks private-network playlists unless --allow-private-network is used', async () => {
    const output = join(tempRoot, 'private.mp4');
    const error = await commandBare([`${baseUrl}/media.m3u8`, output]).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('private network');
  });

  it('rejects segments above --max-segment-size', async () => {
    const output = join(tempRoot, 'too-large.mp4');
    const error = await command([
      `${baseUrl}/media.m3u8`,
      output,
      '--max-segment-size',
      '1000',
    ]).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('above the 1000 B limit');
  });

  it('enforces the total download limit', async () => {
    const output = join(tempRoot, 'download-limit.mp4');
    const error = await command([
      `${baseUrl}/media.m3u8`,
      output,
      '--max-download',
      '150KB',
    ]).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('limit');
  });

  it('resolves relative segment URLs against a redirected playlist URL', async () => {
    segmentRequests = [];
    const output = join(tempRoot, 'redirect.mp4');

    await command([`${baseUrl}/nested/redirect.m3u8`, output]);

    expect(segmentRequests).toHaveLength(3);
    expect(segmentRequests.every(path => path.startsWith('/other/segments/'))).toBe(true);
  });

  it('selects the highest-quality variant when no index is provided', async () => {
    segmentRequests = [];
    const output = join(tempRoot, 'master.mp4');

    const { stdout } = await command([`${baseUrl}/unsorted.m3u8`, output]);

    expect(stdout).toContain('Selected variant: 1280x720 @ 2000 kbps');
    expect(segmentRequests).toHaveLength(3);
  });

  it('merges a saved directory with --merge-only', async () => {
    const resumeDir = join(tempRoot, 'offline-merge');
    const downloadOutput = join(tempRoot, 'offline-merge-download.mp4');
    await mkdir(resumeDir, { recursive: true });
    await command([`${baseUrl}/media.m3u8`, downloadOutput, '--resume', resumeDir]);

    const output = join(tempRoot, 'offline-merge.mp4');
    segmentRequests = [];
    const { stdout } = await commandBare(['--merge-only', resumeDir, output]);

    expect(stdout).toContain('Done! Saved to');
    expect(segmentRequests).toHaveLength(0);
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
    const metadata = JSON.parse(
      await readFile(join(resumeDir, 'meow-loader.resume.json'), 'utf8'),
    ) as { durationSeconds?: number };
    expect(metadata.durationSeconds).toBeCloseTo(30);
    expect((await readdir(resumeDir)).some(file => /^segment_\d+\.ts$/.test(file))).toBe(true);
  });

  it('merges directories from older versions without a recorded duration', async () => {
    const resumeDir = join(tempRoot, 'offline-legacy');
    await mkdir(resumeDir, { recursive: true });
    await command([
      `${baseUrl}/media.m3u8`,
      join(tempRoot, 'offline-legacy-download.mp4'),
      '--resume',
      resumeDir,
    ]);

    const metadataPath = join(resumeDir, 'meow-loader.resume.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    delete metadata.durationSeconds;
    delete metadata.container;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const output = join(tempRoot, 'offline-legacy.mp4');
    const { stdout } = await commandBare(['--merge-only', resumeDir, output]);

    expect(stdout).toContain('Done! Saved to');
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
  });

  it('removes segments with --merge-only --cleanup', async () => {
    const resumeDir = join(tempRoot, 'offline-cleanup');
    await mkdir(resumeDir, { recursive: true });
    await command([
      `${baseUrl}/media.m3u8`,
      join(tempRoot, 'offline-cleanup-download.mp4'),
      '--resume',
      resumeDir,
    ]);

    await commandBare([
      '--merge-only',
      resumeDir,
      join(tempRoot, 'offline-cleanup.mp4'),
      '--cleanup',
    ]);

    const files = await readdir(resumeDir);
    expect(files.filter(file => /^segment_\d+\.ts$/.test(file))).toHaveLength(0);
    expect(files).not.toContain('meow-loader.resume.json');
  });

  it('refuses to merge a saved directory with missing segments', async () => {
    const resumeDir = join(tempRoot, 'offline-missing');
    await mkdir(resumeDir, { recursive: true });
    await command([
      `${baseUrl}/media.m3u8`,
      join(tempRoot, 'offline-missing-download.mp4'),
      '--resume',
      resumeDir,
    ]);

    const files = await readdir(resumeDir);
    const segment = files.find(file => /^segment_\d+\.ts$/.test(file))!;
    await rm(join(resumeDir, segment));

    const error = await commandBare([
      '--merge-only',
      resumeDir,
      join(tempRoot, 'offline-missing.mp4'),
    ]).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('segments are missing or corrupt');
  });

  it('requires resume metadata for --merge-only', async () => {
    const emptyDir = join(tempRoot, 'offline-no-metadata');
    await mkdir(emptyDir, { recursive: true });

    const error = await commandBare([
      '--merge-only',
      emptyDir,
      join(tempRoot, 'offline-no-metadata.mp4'),
    ]).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('meow-loader.resume.json');
  });

  it('resumes without deleting unrelated files in the resume directory', async () => {
    const resumeDir = join(tempRoot, 'resume-keep');
    const output = join(tempRoot, 'resume.mp4');
    const sentinel = join(resumeDir, 'keep.txt');
    await mkdir(resumeDir, { recursive: true });
    await writeFile(sentinel, 'do not delete');

    await command([`${baseUrl}/media.m3u8`, output, '--resume', resumeDir]);

    expect(await readFile(sentinel, 'utf8')).toBe('do not delete');
    const files = await readdir(resumeDir);
    expect(files.some(file => /^segment_\d+\.ts$/.test(file))).toBe(true);
  });

  it('refuses to resume with a different media playlist or variant', async () => {
    const resumeDir = join(tempRoot, 'resume-variant');
    const firstOutput = join(tempRoot, 'variant-first.mp4');
    const secondOutput = join(tempRoot, 'variant-second.mp4');
    await mkdir(resumeDir, { recursive: true });

    await command([`${baseUrl}/master.m3u8`, firstOutput, '0', '--resume', resumeDir]);
    const error = await command([`${baseUrl}/master.m3u8`, secondOutput, '1', '--resume', resumeDir]).catch(
      error => error,
    );

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('different media playlist or variant');
  });

  it('handles a resume directory containing quote and newline characters', async () => {
    const resumeDir = join(tempRoot, "quote'\nfile 'injected.ts' dir");
    const output = join(tempRoot, 'weird-resume.mp4');
    await mkdir(resumeDir, { recursive: true });

    await command([`${baseUrl}/media.m3u8`, output, '--resume', resumeDir]);

    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
  });

  it('refuses to resume query-distinct variants that share a pathname', async () => {
    const resumeDir = join(tempRoot, 'resume-query');
    const firstOutput = join(tempRoot, 'query-first.mp4');
    const secondOutput = join(tempRoot, 'query-second.mp4');
    await mkdir(resumeDir, { recursive: true });

    await command([`${baseUrl}/query-master.m3u8`, firstOutput, '0', '--resume', resumeDir]);
    const error = await command([`${baseUrl}/query-master.m3u8`, secondOutput, '1', '--resume', resumeDir]).catch(
      error => error,
    );

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('different media playlist or variant');
  });

  it('re-downloads a resumed segment whose hash no longer matches', async () => {
    const resumeDir = join(tempRoot, 'resume-hash');
    const firstOutput = join(tempRoot, 'hash-first.mp4');
    const secondOutput = join(tempRoot, 'hash-second.mp4');
    await mkdir(resumeDir, { recursive: true });

    await command([`${baseUrl}/media.m3u8`, firstOutput, '--resume', resumeDir]);
    await copyFile(join(fixtures, 'segments', 'segment_001_blue.ts'), join(resumeDir, 'segment_0.ts'));

    segmentRequests = [];
    await command([`${baseUrl}/media.m3u8`, secondOutput, '--resume', resumeDir]);

    expect(segmentRequests).toEqual(['/segments/segment_000_red.ts']);
    expect((await readFile(secondOutput)).byteLength).toBeGreaterThan(0);
  });

  it('only removes meow-loader files when --cleanup is used', async () => {
    const resumeDir = join(tempRoot, 'resume-cleanup');
    const output = join(tempRoot, 'cleanup.mp4');
    const sentinel = join(resumeDir, 'keep.txt');
    const unrelatedSegment = join(resumeDir, 'segment_999.ts');
    const unrelatedPartial = join(resumeDir, 'segment_999.ts.part');
    const firstOutput = join(tempRoot, 'cleanup-first.mp4');

    await mkdir(resumeDir, { recursive: true });
    await writeFile(sentinel, 'keep me');
    await writeFile(unrelatedSegment, 'unrelated');
    await writeFile(unrelatedPartial, 'unrelated partial');

    await command([`${baseUrl}/media.m3u8`, firstOutput, '--resume', resumeDir]);
    await command([`${baseUrl}/media.m3u8`, output, '--resume', resumeDir, '--cleanup']);

    expect(await readFile(sentinel, 'utf8')).toBe('keep me');
    expect(await readFile(unrelatedSegment, 'utf8')).toBe('unrelated');
    expect(await readFile(unrelatedPartial, 'utf8')).toBe('unrelated partial');
    const files = await readdir(resumeDir);
    expect(files).not.toContain('segment_0.ts');
    expect(files).not.toContain('meow-loader.resume.json');
  });

  it('applies custom headers case-insensitively', async () => {
    const output = join(tempRoot, 'headers.mp4');

    await command([
      `${baseUrl}/headers.m3u8`,
      output,
      '-H',
      'user-agent: custom-agent',
      '-H',
      'X-Test-Header: yes',
    ]);

    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
  });

  it('fails clearly for live playlists', async () => {
    const error = await command([`${baseUrl}/live.m3u8`, join(tempRoot, 'live.mp4')]).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('Live or incomplete playlists are not supported');
  });

  it('downloads and merges fragmented MP4 playlists', async () => {
    const info = await command([`${baseUrl}/fmp4.m3u8`, '--dry-run']);
    expect(info.stdout).toContain('Container: fMP4');
    expect(info.stdout).toContain('Segments: 3');

    const output = join(tempRoot, 'fmp4.mp4');
    const { stdout } = await command([`${baseUrl}/fmp4.m3u8`, output]);

    expect(stdout).toContain('Downloading initialization segment');
    expect(stdout).toContain('Done! Saved to');
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
  });

  it('merges a saved fMP4 directory with --merge-only', async () => {
    const resumeDir = join(tempRoot, 'fmp4-offline');
    await mkdir(resumeDir, { recursive: true });
    await command([
      `${baseUrl}/fmp4.m3u8`,
      join(tempRoot, 'fmp4-source.mp4'),
      '--resume',
      resumeDir,
    ]);

    const output = join(tempRoot, 'fmp4-offline.mp4');
    const { stdout } = await commandBare(['--merge-only', resumeDir, output]);

    expect(stdout).toContain('Done! Saved to');
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
  });

  it('resumes fMP4 downloads and reuses the initialization segment', async () => {
    const resumeDir = join(tempRoot, 'fmp4-resume');
    await mkdir(resumeDir, { recursive: true });
    await command([
      `${baseUrl}/fmp4.m3u8`,
      join(tempRoot, 'fmp4-resume-first.mp4'),
      '--resume',
      resumeDir,
    ]);

    const files = await readdir(resumeDir);
    const segment = files.find(file => file.endsWith('.m4s'))!;
    await rm(join(resumeDir, segment));

    const { stdout } = await command([
      `${baseUrl}/fmp4.m3u8`,
      join(tempRoot, 'fmp4-resume-second.mp4'),
      '--resume',
      resumeDir,
    ]);

    expect(stdout).toContain('Resuming with 2/3 segments already downloaded');
    expect(stdout).not.toContain('Downloading initialization segment');
    expect(stdout).toContain('Done! Saved to');
  });

  it('rejects a non-fMP4 initialization segment', async () => {
    const error = await command([`${baseUrl}/fmp4-bad.m3u8`, join(tempRoot, 'bad-fmp4.mp4')]).catch(
      error => error,
    );

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('not a valid fragmented MP4 file');
  });

  it('rejects an HTML response served as a segment', async () => {
    const output = join(tempRoot, 'corrupt.mp4');
    await writeFile(output, 'original');

    const error = await command([`${baseUrl}/corrupt.m3u8`, output, '--force']).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('not a valid MPEG-TS segment');
    expect(await readFile(output, 'utf8')).toBe('original');
  });

  it('rejects a truncated TS segment that would produce a short output', async () => {
    const output = join(tempRoot, 'truncated.mp4');
    await writeFile(output, 'original');

    const error = await command([`${baseUrl}/truncated.m3u8`, output, '--force']).catch(error => error);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('does not match playlist duration');
    expect(await readFile(output, 'utf8')).toBe('original');
  });

  it('refuses to overwrite an explicit output unless --force is used', async () => {
    const output = join(tempRoot, 'existing.mp4');
    const partialSentinel = join(tempRoot, 'existing.part.mp4');
    await writeFile(output, 'original');
    await writeFile(partialSentinel, 'keep this too');

    await expect(command([`${baseUrl}/media.m3u8`, output])).rejects.toMatchObject({ code: 1 });
    expect(await readFile(output, 'utf8')).toBe('original');

    await command([`${baseUrl}/media.m3u8`, output, '--force']);
    expect((await readFile(output)).byteLength).toBeGreaterThan('original'.length);
    expect(await readFile(partialSentinel, 'utf8')).toBe('keep this too');
  });

  it('rejects an output filename without an .mp4 extension', async () => {
    const output = join(tempRoot, 'video.mkv');

    await expect(command([`${baseUrl}/media.m3u8`, output])).rejects.toMatchObject({ code: 1 });
  });
});
