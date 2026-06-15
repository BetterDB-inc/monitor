import { describe, it, expect } from 'vitest';
import { isIndexNotFoundError } from '../errors';

describe('isIndexNotFoundError', () => {
  it('matches "unknown index name" case-insensitively', () => {
    expect(isIndexNotFoundError(new Error('Unknown Index Name'))).toBe(true);
    expect(isIndexNotFoundError(new Error('UNKNOWN INDEX NAME sc:idx'))).toBe(true);
  });

  it('matches "no such index" case-insensitively', () => {
    expect(isIndexNotFoundError(new Error('no such index'))).toBe(true);
    expect(isIndexNotFoundError(new Error('sc:idx: No Such Index'))).toBe(true);
  });

  it('matches Redis 8 FT.SEARCH phrasing', () => {
    expect(isIndexNotFoundError(new Error('No such index nonexistent_idx_xyz'))).toBe(true);
  });

  it('matches index-scoped not-found phrasings', () => {
    expect(isIndexNotFoundError(new Error('Index sc:idx: not found'))).toBe(true);
    expect(isIndexNotFoundError(new Error('index not found'))).toBe(true);
    expect(isIndexNotFoundError(new Error('Index with name foo not found'))).toBe(true);
  });

  it('matches the valkey-search 1.2 phrasing', () => {
    expect(
      isIndexNotFoundError(
        new Error("Index with name 'nonexistent_idx_xyz' not found in database 0"),
      ),
    ).toBe(true);
  });

  it('rejects not-found messages without index context', () => {
    expect(isIndexNotFoundError(new Error('key not found'))).toBe(false);
    expect(isIndexNotFoundError(new Error('function not found'))).toBe(false);
    expect(isIndexNotFoundError(new Error('ERR value not found'))).toBe(false);
  });

  it('rejects index messages without not-found context', () => {
    expect(isIndexNotFoundError(new Error('index is being created'))).toBe(false);
  });

  it('rejects unrelated error messages', () => {
    expect(isIndexNotFoundError(new Error('connection refused'))).toBe(false);
  });

  it('rejects non-Error values', () => {
    expect(isIndexNotFoundError('index not found')).toBe(false);
    expect(isIndexNotFoundError(undefined)).toBe(false);
    expect(isIndexNotFoundError(null)).toBe(false);
    expect(isIndexNotFoundError({ message: 'index not found' })).toBe(false);
  });
});
