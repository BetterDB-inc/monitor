import { describe, it, expect } from 'vitest';
import { isIndexNotFoundError } from '../errors';

describe('isIndexNotFoundError', () => {
  it('matches "unknown index name" case-insensitively', () => {
    expect(isIndexNotFoundError(new Error('Unknown Index Name'))).toBe(true);
  });

  it('matches "no such index"', () => {
    expect(isIndexNotFoundError(new Error('no such index'))).toBe(true);
  });

  it('matches "not found"', () => {
    expect(isIndexNotFoundError(new Error('Index sc:idx: not found'))).toBe(true);
  });

  it('rejects unrelated error messages', () => {
    expect(isIndexNotFoundError(new Error('connection refused'))).toBe(false);
  });

  it('rejects non-Error values', () => {
    expect(isIndexNotFoundError('not found')).toBe(false);
    expect(isIndexNotFoundError(undefined)).toBe(false);
    expect(isIndexNotFoundError(null)).toBe(false);
  });
});
