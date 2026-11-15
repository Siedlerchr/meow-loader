/**
 * Helpers for HLS WebVTT subtitle playlists. Each HLS subtitle segment is a
 * WebVTT file, so merging them means keeping one header and concatenating the
 * cue blocks.
 */

export function isValidWebVttSegment(text: string): boolean {
  const normalized = text.replace(/^\uFEFF/, '').trim();
  if (!normalized) {
    return false;
  }

  return /^WEBVTT(?:\s|$)/.test(normalized) || normalized.includes('-->');
}

export function mergeWebVttSegments(segments: string[]): string {
  let header: string | undefined;
  const cues: string[] = [];

  for (const segment of segments) {
    const normalized = segment.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      continue;
    }

    const { header: segmentHeader, body } = splitHeader(normalized);
    if (header === undefined && segmentHeader) {
      header = segmentHeader;
    }

    const cue = body.trim();
    if (cue) {
      cues.push(cue);
    }
  }

  if (header === undefined) {
    return '';
  }

  if (cues.length === 0) {
    return `${header.trimEnd()}\n`;
  }

  return `${header.trimEnd()}\n\n${cues.join('\n\n')}\n`;
}

function splitHeader(text: string): { header: string; body: string } {
  if (!/^WEBVTT(?:\s|$)/.test(text)) {
    return { header: '', body: text };
  }

  const separator = text.indexOf('\n\n');
  if (separator === -1) {
    return { header: text, body: '' };
  }

  return {
    header: text.slice(0, separator),
    body: text.slice(separator + 2),
  };
}
