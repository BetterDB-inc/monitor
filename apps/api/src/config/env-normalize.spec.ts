import { DEFAULT_AUTH_BROKER_URL, isTrueFlag, normalizeOptionalUrl } from './env-normalize';

describe('isTrueFlag', () => {
  it('accepts only the string true', () => {
    expect(isTrueFlag('true')).toBe(true);
    expect(isTrueFlag(' true ')).toBe(true);
    expect(isTrueFlag('false')).toBe(false);
    expect(isTrueFlag('1')).toBe(false);
    expect(isTrueFlag(undefined)).toBe(false);
    expect(isTrueFlag(true)).toBe(false);
  });
});

describe('normalizeOptionalUrl', () => {
  it('strips whitespace and trailing slashes', () => {
    expect(normalizeOptionalUrl('  https://mon.example.com//  ')).toBe('https://mon.example.com');
  });

  it('treats an empty or missing value as unset', () => {
    expect(normalizeOptionalUrl('')).toBeNull();
    expect(normalizeOptionalUrl('   ')).toBeNull();
    expect(normalizeOptionalUrl(undefined)).toBeNull();
  });

  it('keeps a url without a trailing slash unchanged', () => {
    expect(normalizeOptionalUrl(DEFAULT_AUTH_BROKER_URL)).toBe(DEFAULT_AUTH_BROKER_URL);
  });
});
