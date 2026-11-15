export interface M3U8Segment {
  uri: string;
  duration: number;
  title?: string;
  /** HLS media sequence number used for the default AES-128 IV. */
  sequence: number;
  encryption?: M3U8Encryption;
  /** Resolved byte range within the URI. */
  byterange?: { length: number; offset: number };
}

export interface M3U8Encryption {
  method: 'AES-128';
  uri: string;
  iv?: string;
}

export interface M3U8ByteRange {
  length: number;
  offset?: number;
}

export interface M3U8Map {
  uri: string;
  byterange?: M3U8ByteRange;
  encryption?: M3U8Encryption;
}

export interface M3U8Playlist {
  isMaster: boolean;
  variants?: M3U8Variant[];
  media?: M3U8Media[];
  segments?: M3U8Segment[];
  targetDuration?: number;
  mediaSequence: number;
  hasEndList: boolean;
  hasMap: boolean;
  map?: M3U8Map;
  hasByteRange: boolean;
  separateAudioGroups: string[];
}

export interface M3U8Media {
  type: string;
  groupId: string;
  name?: string;
  language?: string;
  uri?: string;
  default: boolean;
  autoselect: boolean;
  channels?: string;
}

export interface M3U8Variant {
  bandwidth: number;
  resolution?: string;
  uri: string;
  audioGroup?: string;
  subtitleGroup?: string;
}

export function parseM3U8(content: string): M3U8Playlist {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines[0] !== '#EXTM3U') {
    throw new Error('Invalid M3U8 file: missing #EXTM3U header');
  }

  const playlist: M3U8Playlist = {
    isMaster: false,
    segments: [],
    mediaSequence: 0,
    hasEndList: false,
    hasMap: false,
    hasByteRange: false,
    separateAudioGroups: [],
  };

  let currentSegment: { duration: number; title?: string } | undefined;
  let currentEncryption: M3U8Encryption | undefined;
  let pendingByteRange: M3U8ByteRange | undefined;
  let pendingVariantAttrs: Record<string, string | undefined> | undefined;
  let segmentIndex = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (!playlist.isMaster) {
        playlist.isMaster = true;
        playlist.variants = [];
        playlist.segments = undefined;
      }
      if (pendingVariantAttrs) {
        throw new Error('Invalid M3U8 file: #EXT-X-STREAM-INF without a URI');
      }
      pendingVariantAttrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      const type = (attrs.TYPE || '').toUpperCase();
      const groupId = attrs['GROUP-ID'];

      if (groupId) {
        const media: M3U8Media = {
          type,
          groupId,
          name: attrs.NAME,
          language: attrs.LANGUAGE,
          uri: attrs.URI,
          default: (attrs.DEFAULT || '').toUpperCase() === 'YES',
          autoselect: (attrs.AUTOSELECT || '').toUpperCase() === 'YES',
          channels: attrs.CHANNELS,
        };
        playlist.media ??= [];
        playlist.media.push(media);
      }

      if (type === 'AUDIO' && attrs.URI && groupId) {
        if (!playlist.separateAudioGroups.includes(groupId)) {
          playlist.separateAudioGroups.push(groupId);
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const targetDuration = Number.parseFloat(line.slice(line.indexOf(':') + 1));
      if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
        throw new Error('Invalid #EXT-X-TARGETDURATION');
      }
      playlist.targetDuration = targetDuration;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      if (!/^\d+$/.test(value)) {
        throw new Error('Invalid #EXT-X-MEDIA-SEQUENCE');
      }
      const mediaSequence = Number(value);
      if (!Number.isSafeInteger(mediaSequence)) {
        throw new Error('Invalid #EXT-X-MEDIA-SEQUENCE');
      }
      playlist.mediaSequence = mediaSequence;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      const method = (attrs.METHOD || 'NONE').toUpperCase();

      if (method === 'NONE') {
        currentEncryption = undefined;
      } else if (method === 'AES-128') {
        const keyFormat = attrs.KEYFORMAT;
        if (keyFormat && keyFormat.toLowerCase() !== 'identity') {
          throw new Error('Unsupported AES-128 key format (only identity is supported)');
        }
        if (!attrs.URI) {
          throw new Error('Invalid M3U8 file: AES-128 key is missing the URI attribute');
        }
        if (!isSupportedKeyUri(attrs.URI)) {
          throw new Error('Unsupported AES-128 key URI (only HTTP(S) and relative URLs are supported)');
        }
        currentEncryption = {
          method: 'AES-128',
          uri: attrs.URI,
          iv: attrs.IV,
        };
      } else {
        throw new Error('Unsupported encryption method (only AES-128 and NONE are supported)');
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const separator = line.indexOf(':');
      const attrs = separator === -1 ? {} : parseAttributes(line.slice(separator + 1));
      const uri = attrs.URI;
      if (!uri) {
        throw new Error('Invalid M3U8 file: #EXT-X-MAP is missing the URI attribute');
      }
      if (!isSupportedKeyUri(uri)) {
        throw new Error(
          'Unsupported #EXT-X-MAP URI (only HTTP(S) and relative URLs are supported)',
        );
      }

      const map: M3U8Map = {
        uri,
        ...(attrs.BYTERANGE ? { byterange: parseByteRange(attrs.BYTERANGE) } : {}),
        ...(currentEncryption ? { encryption: { ...currentEncryption } } : {}),
      };

      if (playlist.map) {
        if (!sameMap(playlist.map, map)) {
          throw new Error('Changing the initialization segment mid-playlist is not supported');
        }
      } else {
        if (playlist.segments && playlist.segments.length > 0) {
          throw new Error('Initialization segments after media segments are not supported');
        }
        playlist.map = map;
      }

      playlist.hasMap = true;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      if (pendingByteRange) {
        throw new Error('Invalid M3U8 file: duplicate #EXT-X-BYTERANGE before a segment URI');
      }
      const separator = line.indexOf(':');
      if (separator === -1) {
        throw new Error('Invalid #EXT-X-BYTERANGE value');
      }
      pendingByteRange = parseByteRange(line.slice(separator + 1));
      playlist.hasByteRange = true;
      continue;
    }

    if (line.startsWith('#EXT-X-ENDLIST')) {
      playlist.hasEndList = true;
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      if (currentSegment) {
        throw new Error('Invalid M3U8 file: duplicate #EXTINF before a segment URI');
      }

      const separator = line.indexOf(':');
      const comma = line.indexOf(',', separator + 1);
      const durationText = comma === -1 ? line.slice(separator + 1) : line.slice(separator + 1, comma);
      const duration = Number.parseFloat(durationText);
      if (!Number.isFinite(duration) || duration < 0) {
        throw new Error('Invalid #EXTINF duration');
      }
      currentSegment = {
        duration,
        title: comma === -1 ? undefined : line.slice(comma + 1),
      };
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    if (playlist.isMaster && playlist.variants) {
      if (!pendingVariantAttrs) {
        throw new Error('Invalid M3U8 file: segment URI without #EXT-X-STREAM-INF');
      }

      const attrs = pendingVariantAttrs;
      const bandwidth = Number.parseInt(attrs.BANDWIDTH || '0', 10);
      playlist.variants.push({
        bandwidth: Number.isNaN(bandwidth) ? 0 : bandwidth,
        resolution: attrs.RESOLUTION,
        uri: line,
        audioGroup: attrs.AUDIO,
        subtitleGroup: attrs.SUBTITLES,
      });
      pendingVariantAttrs = undefined;
      continue;
    }

    if (!currentSegment) {
      throw new Error('Invalid M3U8 file: segment URI without #EXTINF');
    }

    const byterange = pendingByteRange
      ? resolveSegmentByteRange(pendingByteRange, line, playlist.segments!)
      : undefined;

    playlist.segments!.push({
      uri: line,
      duration: currentSegment.duration,
      title: currentSegment.title,
      sequence: playlist.mediaSequence + segmentIndex,
      ...(byterange ? { byterange } : {}),
      ...(currentEncryption ? { encryption: { ...currentEncryption } } : {}),
    });
    pendingByteRange = undefined;
    segmentIndex++;
    currentSegment = undefined;
  }

  if (currentSegment) {
    throw new Error('Invalid M3U8 file: #EXTINF without a segment URI');
  }
  if (pendingVariantAttrs) {
    throw new Error('Invalid M3U8 file: #EXT-X-STREAM-INF without a URI');
  }
  if (pendingByteRange) {
    throw new Error('Invalid M3U8 file: #EXT-X-BYTERANGE without a segment URI');
  }

  return playlist;
}

/** Return variants ordered from highest to lowest bandwidth. */
export function sortVariantsByBandwidth(variants: M3U8Variant[]): M3U8Variant[] {
  return [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
}

/**
 * Audio renditions that have their own playlist, ordered for display and
 * selection: DEFAULT first, then AUTOSELECT, then playlist order.
 */
function sortRenditions(
  media: M3U8Media[] | undefined,
  groupId: string | undefined,
  type: string,
): M3U8Media[] {
  if (!groupId || !media) {
    return [];
  }

  const rank = (entry: M3U8Media): number => (entry.default ? 0 : entry.autoselect ? 1 : 2);

  return media
    .filter(entry => entry.type === type && entry.groupId === groupId && entry.uri)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(item => item.entry);
}

export function sortAudioRenditions(
  media: M3U8Media[] | undefined,
  groupId: string | undefined,
): M3U8Media[] {
  return sortRenditions(media, groupId, 'AUDIO');
}

export function sortSubtitleRenditions(
  media: M3U8Media[] | undefined,
  groupId: string | undefined,
): M3U8Media[] {
  return sortRenditions(media, groupId, 'SUBTITLES');
}

/**
 * Pick the audio rendition referenced by a variant's AUDIO group. Prefers the
 * DEFAULT rendition, then AUTOSELECT, then the first entry that has a URI.
 * Returns undefined when the audio is muxed into the variant.
 */
export function selectAudioRendition(
  media: M3U8Media[] | undefined,
  groupId: string | undefined,
): M3U8Media | undefined {
  return sortAudioRenditions(media, groupId)[0];
}

function isSupportedKeyUri(uri: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    return /^https?:/i.test(uri);
  }
  return true;
}

function parseByteRange(value: string): M3U8ByteRange {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new Error('Invalid #EXT-X-BYTERANGE value');
  }

  const length = Number(match[1]);
  const offset = match[2] === undefined ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    (offset !== undefined && !Number.isSafeInteger(offset))
  ) {
    throw new Error('Invalid #EXT-X-BYTERANGE value');
  }

  return { length, ...(offset !== undefined ? { offset } : {}) };
}

function sameMap(a: M3U8Map, b: M3U8Map): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolveSegmentByteRange(
  range: M3U8ByteRange,
  uri: string,
  segments: M3U8Segment[],
): { length: number; offset: number } {
  if (range.offset !== undefined) {
    return { length: range.length, offset: range.offset };
  }

  const previous = segments[segments.length - 1];
  if (previous?.byterange && previous.uri === uri) {
    return {
      length: range.length,
      offset: previous.byterange.offset + previous.byterange.length,
    };
  }

  throw new Error(
    'Invalid M3U8 file: #EXT-X-BYTERANGE without an offset must follow a segment from the same resource',
  );
}

function parseAttributes(str: string): Record<string, string | undefined> {
  const attrs: Record<string, string | undefined> = {};
  const regex = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(str)) !== null) {
    attrs[match[1]!] = match[3] ?? match[4];
  }

  return attrs;
}
