import { describe, it, expect } from 'vitest';
import {
  computeValkeySizing,
  parseMaxmemoryMi,
  MAX_VALKEY_MAXMEMORY_MI,
} from '../sizing';

describe('computeValkeySizing', () => {
  it('matches the documented tenant profile (512mb -> 1Gi limit, 2Gi volume)', () => {
    expect(computeValkeySizing('512mb')).toEqual({
      memoryLimit: '1Gi',
      persistenceSize: '2Gi',
    });
  });

  it('scales the selectable sizes', () => {
    expect(computeValkeySizing('256mb')).toEqual({
      memoryLimit: '512Mi', // floor: chart default
      persistenceSize: '1Gi', // floor: chart default
    });
    expect(computeValkeySizing('768mb')).toEqual({
      memoryLimit: '1536Mi',
      persistenceSize: '3Gi',
    });
    expect(computeValkeySizing('1gb')).toEqual({
      memoryLimit: '2Gi',
      persistenceSize: '4Gi',
    });
    expect(computeValkeySizing('2gb')).toEqual({
      memoryLimit: '4Gi',
      persistenceSize: '8Gi',
    });
  });

  it('never sizes below the chart defaults', () => {
    expect(computeValkeySizing('64mb')).toEqual({
      memoryLimit: '512Mi',
      persistenceSize: '1Gi',
    });
    expect(computeValkeySizing('1024kb')).toEqual({
      memoryLimit: '512Mi',
      persistenceSize: '1Gi',
    });
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(computeValkeySizing('1GB')).toEqual({
      memoryLimit: '2Gi',
      persistenceSize: '4Gi',
    });
    expect(computeValkeySizing(' 768mb ')).toEqual({
      memoryLimit: '1536Mi',
      persistenceSize: '3Gi',
    });
  });

  it('returns null for missing or unparseable values so chart defaults apply', () => {
    expect(computeValkeySizing(null)).toBeNull();
    expect(computeValkeySizing('')).toBeNull();
    expect(computeValkeySizing('1g')).toBeNull();
    expect(computeValkeySizing('1tb')).toBeNull();
    expect(computeValkeySizing('abc')).toBeNull();
    expect(computeValkeySizing('0mb')).toBeNull();
  });

  it('never sizes beyond the 2gb cap even for oversized input', () => {
    expect(computeValkeySizing('100gb')).toEqual({
      memoryLimit: '4Gi',
      persistenceSize: '8Gi',
    });
  });
});

describe('parseMaxmemoryMi', () => {
  it('parses supported units into MiB', () => {
    expect(parseMaxmemoryMi('1024kb')).toBe(1);
    expect(parseMaxmemoryMi('768mb')).toBe(768);
    expect(parseMaxmemoryMi('2gb')).toBe(2048);
  });

  it('returns null for invalid input', () => {
    expect(parseMaxmemoryMi('')).toBeNull();
    expect(parseMaxmemoryMi('two gb')).toBeNull();
    expect(parseMaxmemoryMi('-1gb')).toBeNull();
    expect(parseMaxmemoryMi('0kb')).toBeNull();
  });

  it('exposes the 2gb cap constant', () => {
    expect(MAX_VALKEY_MAXMEMORY_MI).toBe(2048);
  });
});
