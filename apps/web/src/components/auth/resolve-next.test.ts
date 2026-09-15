import { describe, expect, it } from 'vitest';
import { resolveNext } from './resolve-next';

describe('resolveNext', () => {
  it('returns / when next is missing', () => {
    expect(resolveNext(null)).toBe('/');
  });

  it('returns a safe same-app relative path unchanged', () => {
    expect(resolveNext('/latency')).toBe('/latency');
    expect(resolveNext('/settings?tab=mcp')).toBe('/settings?tab=mcp');
  });

  it('rejects a path that does not start with a slash', () => {
    expect(resolveNext('latency')).toBe('/');
    expect(resolveNext('javascript:alert(1)')).toBe('/');
    expect(resolveNext('https://evil.com')).toBe('/');
  });

  it('rejects a protocol-relative path', () => {
    expect(resolveNext('//evil.com')).toBe('/');
    expect(resolveNext('///evil.com')).toBe('/');
  });

  it('rejects a path containing a backslash', () => {
    expect(resolveNext('/\\evil.com')).toBe('/');
    expect(resolveNext('/ok/\\evil.com')).toBe('/');
  });
});
