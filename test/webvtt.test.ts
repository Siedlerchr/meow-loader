import { describe, expect, it } from 'vitest';
import { isValidWebVttSegment, mergeWebVttSegments } from '../src/webvtt';

describe('mergeWebVttSegments', () => {
  it('keeps one header and concatenates cues', () => {
    const merged = mergeWebVttSegments([
      `WEBVTT
X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000

00:00:00.000 --> 00:00:05.000
first`,
      `WEBVTT

00:00:10.000 --> 00:00:15.000
second`,
    ]);

    expect(merged.match(/WEBVTT/g)).toHaveLength(1);
    expect(merged).toContain('X-TIMESTAMP-MAP=MPEGTS:0');
    expect(merged).toContain('00:00:00.000 --> 00:00:05.000\nfirst');
    expect(merged).toContain('00:00:10.000 --> 00:00:15.000\nsecond');
  });

  it('accepts segments without their own header', () => {
    const merged = mergeWebVttSegments([
      'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nfirst',
      '00:00:05.000 --> 00:00:10.000\nsecond',
    ]);

    expect(merged).toContain('first');
    expect(merged).toContain('second');
    expect(merged.match(/WEBVTT/g)).toHaveLength(1);
  });

  it('normalizes BOM and CRLF', () => {
    const merged = mergeWebVttSegments([
      '\uFEFFWEBVTT\r\n\r\n00:00:00.000 --> 00:00:05.000\r\nline\r\n',
    ]);

    expect(merged).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nline\n');
  });

  it('returns an empty string when nothing is provided', () => {
    expect(mergeWebVttSegments([])).toBe('');
    expect(mergeWebVttSegments(['', '   '])).toBe('');
  });

  it('keeps a header-only playlist', () => {
    expect(mergeWebVttSegments(['WEBVTT'])).toBe('WEBVTT\n');
  });
});

describe('isValidWebVttSegment', () => {
  it('accepts WebVTT files and bare cue blocks', () => {
    expect(isValidWebVttSegment('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello')).toBe(true);
    expect(isValidWebVttSegment('00:00:00.000 --> 00:00:01.000\nhello')).toBe(true);
  });

  it('rejects HTML and empty responses', () => {
    expect(isValidWebVttSegment('<html><body>error</body></html>')).toBe(false);
    expect(isValidWebVttSegment('   ')).toBe(false);
  });
});
