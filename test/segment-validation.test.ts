import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Mp4Validator, MpegTsValidator, scanSegmentFile } from '../src/segment-validation';

const fixtures = join(import.meta.dirname, 'fixtures');

function box(type: string, size = 16): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32BE(size, 0);
  buffer.write(type, 4, 'latin1');
  return buffer;
}

describe('Mp4Validator', () => {
  it('accepts an ftyp initialization header', () => {
    const validator = new Mp4Validator({ requireFtyp: true });

    expect(validator.update(box('ftyp'))).toBe(true);
    expect(validator.valid).toBe(true);
  });

  it('accepts styp media fragments', () => {
    const validator = new Mp4Validator();

    expect(validator.update(box('styp'))).toBe(true);
    expect(validator.valid).toBe(true);
  });

  it('requires ftyp when validating an initialization segment', () => {
    const validator = new Mp4Validator({ requireFtyp: true });

    expect(validator.update(box('styp'))).toBe(false);
    expect(validator.valid).toBe(false);
  });

  it('rejects HTML error pages', () => {
    const validator = new Mp4Validator();

    expect(validator.update(Buffer.from('<html><body>error</body></html>'))).toBe(false);
    expect(validator.valid).toBe(false);
  });

  it('waits for a complete header before deciding', () => {
    const validator = new Mp4Validator();

    expect(validator.update(box('ftyp').subarray(0, 4))).toBe(true);
    expect(validator.valid).toBe(false);
    expect(validator.update(box('ftyp').subarray(4))).toBe(true);
    expect(validator.valid).toBe(true);
  });

  it('rejects implausible box sizes', () => {
    const validator = new Mp4Validator();
    const header = box('ftyp');
    header.writeUInt32BE(4, 0);

    expect(validator.update(header)).toBe(false);
    expect(validator.valid).toBe(false);
  });
});

describe('scanSegmentFile', () => {
  it('validates the fMP4 initialization fixture', async () => {
    const scan = await scanSegmentFile(join(fixtures, 'fmp4', 'init.mp4'), 'fmp4', {
      requireFtyp: true,
    });

    expect(scan.valid).toBe(true);
  });

  it('validates an fMP4 media segment fixture', async () => {
    const scan = await scanSegmentFile(join(fixtures, 'fmp4', 'segment_0.m4s'), 'fmp4');

    expect(scan.valid).toBe(true);
  });

  it('rejects a TS segment when validating fMP4', async () => {
    const scan = await scanSegmentFile(
      join(fixtures, 'segments', 'segment_000_red.ts'),
      'fmp4',
    );

    expect(scan.valid).toBe(false);
  });

  it('rejects an fMP4 init segment when validating MPEG-TS', async () => {
    const scan = await scanSegmentFile(join(fixtures, 'fmp4', 'init.mp4'), 'mpegts');

    expect(scan.valid).toBe(false);
  });

  it('keeps the MPEG-TS validator working', () => {
    const validator = new MpegTsValidator();

    expect(validator.update(Buffer.from([0x47, 0, 0]))).toBe(true);
    expect(validator.valid).toBe(false);
  });
});
