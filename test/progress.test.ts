import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadProgress, ParallelDownloadProgress, ValidationProgress } from '../src/progress';

function captureStdout(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

describe('DownloadProgress', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the rest of the line on TTY renders', () => {
    const writes = captureStdout();

    const progress = new DownloadProgress(2, 0, 0, true);
    progress.startSegment(0);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\rSegment 1\/2 .*\x1b\[K$/);
  });

  it('prefixes the track label', () => {
    const writes = captureStdout();

    const progress = new DownloadProgress(1, 0, 0, true, 'Audio ');
    progress.startSegment(0);

    expect(writes[0]).toContain('Audio Segment 1/1');
  });

  it('renders parallel progress with active counts', () => {
    const writes = captureStdout();

    const progress = new ParallelDownloadProgress(3, 0, 0, true, 'Audio ');
    progress.startSegment(0);
    progress.startSegment(1);

    expect(writes.at(-1)).toContain('Audio Segments 0/3');
    expect(writes.at(-1)).toContain('2 active');

    progress.completeSegment(1000);
    expect(writes.at(-1)).toContain('Audio Segments 1/3');
    expect(writes.at(-1)).toContain('1 active');
  });

  it('renders validation progress and finishes with a newline', () => {
    const writes = captureStdout();

    const progress = new ValidationProgress(10, 1024 * 1024, true);
    progress.update(5, 512 * 1024);

    expect(writes.at(-1)).toContain('Validating existing segments 5/10 files');
    expect(writes.at(-1)).toContain('512.0 KB / 1.0 MB');

    progress.update(10, 1024 * 1024);
    expect(writes.at(-1)).toContain('Validating existing segments 10/10 files');

    progress.finish();
    expect(writes.at(-1)).toBe('\n');
  });

  it('does not write escape sequences when not attached to a TTY', () => {
    const writes = captureStdout();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });

    const progress = new DownloadProgress(2, 0, 0, false);
    progress.startSegment(0);
    progress.completeSegment(1000);

    expect(writes).toHaveLength(0);
    expect(logs.every(line => !line.includes('\x1b'))).toBe(true);
  });
});
