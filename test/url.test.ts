import { describe, expect, it } from 'vitest';
import { normalizeOrigin } from '../src/url';

describe('normalizeOrigin', () => {
  it('normalizes scheme, host case, default port, and trailing slash', () => {
    expect(normalizeOrigin('http://Example.com:80/')).toBe('http://example.com');
    expect(normalizeOrigin('https://CDN.example.com')).toBe('https://cdn.example.com');
  });

  it('rejects credentials, paths, queries, and fragments', () => {
    expect(() => normalizeOrigin('http://user:pass@example.com/')).toThrow('must not include');
    expect(() => normalizeOrigin('http://example.com/path')).toThrow('must not include');
    expect(() => normalizeOrigin('http://example.com/?a=b')).toThrow('must not include');
    expect(() => normalizeOrigin('http://example.com/#frag')).toThrow('must not include');
  });

  it('rejects non-http protocols', () => {
    expect(() => normalizeOrigin('file:///tmp/x')).toThrow('Unsupported origin protocol');
  });
});
