import { formatBytes, formatEta } from './display';

const LARGE_DOWNLOAD_WARNING_BYTES = 5 * 1024 ** 3;

export class DownloadProgress {
  private readonly tty: boolean;
  private readonly totalSegments: number;
  private readonly label: string;
  private completedSegments: number;
  private baseBytes: number;
  private segmentIndex = 0;
  private segmentBytes = 0;
  private segmentExpected: number | undefined;
  private lastRenderAt = 0;
  private lastLogAt = 0;
  private lastSampleAt = Date.now();
  private lastSampleBytes = 0;
  private speedBytesPerSecond = 0;
  private warnedLarge = false;
  private hasRendered = false;

  constructor(
    totalSegments: number,
    initialBytes: number,
    initialCompleted: number,
    tty: boolean,
    label = '',
  ) {
    this.totalSegments = totalSegments;
    this.label = label;
    this.baseBytes = initialBytes;
    this.completedSegments = initialCompleted;
    this.lastSampleBytes = initialBytes;
    this.tty = tty;
  }

  startSegment(index: number, expectedBytes?: number): void {
    this.segmentIndex = index;
    this.segmentBytes = 0;
    this.segmentExpected = expectedBytes;
    this.render(false);
  }

  addBytes(bytes: number): void {
    this.segmentBytes = bytes;
    const now = Date.now();
    if (now - this.lastRenderAt >= 250) {
      this.render(false);
    }
  }

  completeSegment(size: number): void {
    this.baseBytes += size;
    this.completedSegments++;
    this.segmentBytes = 0;
    this.segmentExpected = undefined;
    this.render(true);
  }

  finish(): void {
    if (this.tty && this.hasRendered) {
      process.stdout.write('\n');
    }
  }

  private render(final: boolean): void {
    const now = Date.now();
    this.updateSpeed(now);

    const totalBytes = this.baseBytes + this.segmentBytes;
    if (!this.warnedLarge && totalBytes >= LARGE_DOWNLOAD_WARNING_BYTES) {
      this.warnedLarge = true;
      console.error(
        `Warning: downloaded ${formatBytes(totalBytes)}. Use --max-download to set a hard limit.`,
      );
    }

    const parts = [`${this.label}Segment ${this.segmentIndex + 1}/${this.totalSegments}`];

    if (this.segmentExpected !== undefined) {
      parts.push(`${formatBytes(this.segmentBytes)} / ${formatBytes(this.segmentExpected)}`);
    } else if (this.segmentBytes > 0) {
      parts.push(formatBytes(this.segmentBytes));
    }

    parts.push(`total ${formatBytes(totalBytes)}`);

    if (this.speedBytesPerSecond > 0) {
      parts.push(`${formatBytes(this.speedBytesPerSecond)}/s`);
    }

    const averageBytes =
      this.completedSegments > 0 ? this.baseBytes / this.completedSegments : undefined;
    const remainingSegments = Math.max(0, this.totalSegments - this.completedSegments);
    if (averageBytes !== undefined && this.speedBytesPerSecond > 0) {
      parts.push(`ETA ${formatEta((averageBytes * remainingSegments) / this.speedBytesPerSecond)}`);
    }

    const line = parts.join(' · ');

    if (this.tty) {
      // Erase the rest of the line: the new line can be shorter than the last
      // one, which otherwise leaves stale characters such as "ETA 0:0272".
      process.stdout.write(`\r${line}\x1b[K`);
      this.hasRendered = true;
    } else if (final) {
      const shouldLog =
        this.totalSegments <= 10 ||
        (this.segmentIndex + 1) % 10 === 0 ||
        this.segmentIndex + 1 === this.totalSegments ||
        now - this.lastLogAt >= 5_000;

      if (shouldLog) {
        console.log(line);
        this.lastLogAt = now;
      }
    }

    this.lastRenderAt = now;
  }

  private updateSpeed(now: number): void {
    const elapsed = now - this.lastSampleAt;
    if (elapsed < 500) return;

    const currentBytes = this.baseBytes + this.segmentBytes;
    const deltaBytes = currentBytes - this.lastSampleBytes;
    this.speedBytesPerSecond = (deltaBytes * 1000) / elapsed;
    this.lastSampleAt = now;
    this.lastSampleBytes = currentBytes;
  }
}

/**
 * Progress display for parallel downloads. Bytes are aggregated across all
 * active segments and the line shows completed and in-flight counts instead
 * of a single segment index.
 */
export class ParallelDownloadProgress {
  private readonly tty: boolean;
  private readonly totalSegments: number;
  private readonly label: string;
  private completedSegments: number;
  private activeSegments = 0;
  private bytes: number;
  private lastRenderAt = 0;
  private lastLogAt = 0;
  private lastSampleAt = Date.now();
  private lastSampleBytes: number;
  private speedBytesPerSecond = 0;
  private warnedLarge = false;
  private hasRendered = false;

  constructor(
    totalSegments: number,
    initialBytes: number,
    initialCompleted: number,
    tty: boolean,
    label = '',
  ) {
    this.totalSegments = totalSegments;
    this.label = label;
    this.bytes = initialBytes;
    this.completedSegments = initialCompleted;
    this.lastSampleBytes = initialBytes;
    this.tty = tty;
  }

  startSegment(_index: number, _expectedBytes?: number): void {
    this.activeSegments++;
    this.render(false);
  }

  addBytes(bytes: number): void {
    this.bytes += bytes;
    const now = Date.now();
    if (now - this.lastRenderAt >= 250) {
      this.render(false);
    }
  }

  completeSegment(_size: number): void {
    this.activeSegments = Math.max(0, this.activeSegments - 1);
    this.completedSegments++;
    this.render(false);
  }

  finish(): void {
    if (this.tty && this.hasRendered) {
      process.stdout.write('\n');
    }
  }

  private render(final: boolean): void {
    const now = Date.now();
    this.updateSpeed(now);

    if (!this.warnedLarge && this.bytes >= LARGE_DOWNLOAD_WARNING_BYTES) {
      this.warnedLarge = true;
      console.error(
        `Warning: downloaded ${formatBytes(this.bytes)}. Use --max-download to set a hard limit.`,
      );
    }

    const parts = [
      `${this.label}Segments ${this.completedSegments}/${this.totalSegments}`,
      this.activeSegments > 0 ? `${this.activeSegments} active` : 'finishing',
      `total ${formatBytes(this.bytes)}`,
    ];

    if (this.speedBytesPerSecond > 0) {
      parts.push(`${formatBytes(this.speedBytesPerSecond)}/s`);
    }

    const averageBytes =
      this.completedSegments > 0 ? this.bytes / this.completedSegments : undefined;
    const remainingSegments = Math.max(0, this.totalSegments - this.completedSegments);
    if (averageBytes !== undefined && this.speedBytesPerSecond > 0) {
      parts.push(`ETA ${formatEta((averageBytes * remainingSegments) / this.speedBytesPerSecond)}`);
    }

    const line = parts.join(' · ');

    if (this.tty) {
      process.stdout.write(`\r${line}\x1b[K`);
      this.hasRendered = true;
    } else if (final) {
      const shouldLog =
        this.totalSegments <= 10 ||
        this.completedSegments % 10 === 0 ||
        this.completedSegments === this.totalSegments ||
        now - this.lastLogAt >= 5_000;

      if (shouldLog) {
        console.log(line);
        this.lastLogAt = now;
      }
    }

    this.lastRenderAt = now;
  }

  private updateSpeed(now: number): void {
    const elapsed = now - this.lastSampleAt;
    if (elapsed < 500) return;

    const deltaBytes = this.bytes - this.lastSampleBytes;
    this.speedBytesPerSecond = (deltaBytes * 1000) / elapsed;
    this.lastSampleAt = now;
    this.lastSampleBytes = this.bytes;
  }
}

/**
 * Progress display while validating existing resume segments. Hashing a large
 * directory can take minutes, so show how many files and bytes were checked.
 */
export class ValidationProgress {
  private readonly totalFiles: number;
  private readonly totalBytes: number;
  private readonly tty: boolean;
  private checkedFiles = 0;
  private checkedBytes = 0;
  private lastRenderAt = 0;
  private lastLogAt = 0;
  private hasRendered = false;

  constructor(totalFiles: number, totalBytes: number, tty: boolean) {
    this.totalFiles = totalFiles;
    this.totalBytes = totalBytes;
    this.tty = tty;
  }

  update(checkedFiles: number, checkedBytes: number): void {
    this.checkedFiles = checkedFiles;
    this.checkedBytes = checkedBytes;
    const now = Date.now();

    if (this.tty) {
      if (now - this.lastRenderAt >= 250 || checkedFiles >= this.totalFiles) {
        this.render();
      }
      return;
    }

    if (
      checkedFiles >= this.totalFiles ||
      checkedFiles % 100 === 0 ||
      now - this.lastLogAt >= 5_000
    ) {
      this.render();
      this.lastLogAt = now;
    }
  }

  finish(): void {
    if (this.tty && this.hasRendered) {
      process.stdout.write('\n');
    }
  }

  private render(): void {
    const line = `Validating existing segments ${this.checkedFiles}/${this.totalFiles} files · ${formatBytes(this.checkedBytes)} / ${formatBytes(this.totalBytes)}`;

    if (this.tty) {
      process.stdout.write(`\r${line}\x1b[K`);
      this.hasRendered = true;
    } else {
      console.log(line);
    }

    this.lastRenderAt = Date.now();
  }
}
