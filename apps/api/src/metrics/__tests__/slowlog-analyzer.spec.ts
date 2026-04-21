import {
  analyzeSlowLogPatterns,
  extractKeyPattern,
  createPatternKey,
} from '../slowlog-analyzer';
import { SlowLogEntry } from '../../common/types/metrics.types';

function entry(overrides: Partial<SlowLogEntry> & { command: string[] }): SlowLogEntry {
  return {
    id: 1,
    timestamp: 1_700_000_000_000,
    duration: 10_000,
    clientAddress: '127.0.0.1:50000',
    clientName: '',
    ...overrides,
  };
}

describe('analyzeSlowLogPatterns — FT.* handling', () => {
  it('excludes FT.SEARCH from byKeyPrefix aggregation', () => {
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['FT.SEARCH', 'idx_cache', '*'] }),
      entry({ id: 2, command: ['FT.SEARCH', 'idx_cache', '*'] }),
      entry({ id: 3, command: ['GET', 'user:42'] }),
    ]);

    const prefixes = result.byKeyPrefix.map((p) => p.prefix);
    expect(prefixes).not.toContain('idx_cache:');
    expect(prefixes).toContain('user:');
  });

  it('excludes FT.CREATE, FT.DROPINDEX, FT.ADD, FT.AGGREGATE from byKeyPrefix', () => {
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['FT.CREATE', 'idx_a', 'SCHEMA'] }),
      entry({ id: 2, command: ['FT.DROPINDEX', 'idx_b'] }),
      entry({ id: 3, command: ['FT.ADD', 'idx_c', 'doc1'] }),
      entry({ id: 4, command: ['FT.AGGREGATE', 'idx_d', '*'] }),
    ]);

    expect(result.byKeyPrefix).toHaveLength(0);
  });

  it('preserves FT.SEARCH pattern grouping unchanged', () => {
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['FT.SEARCH', 'idx_cache', '*'] }),
      entry({ id: 2, command: ['FT.SEARCH', 'idx_cache', 'hello'] }),
    ]);

    const ftPattern = result.patterns.find((p) => p.command === 'FT.SEARCH');
    expect(ftPattern).toBeDefined();
    expect(ftPattern!.pattern).toBe('FT.SEARCH idx_cache');
    expect(ftPattern!.keyPattern).toBe('idx_cache');
  });

  it('still aggregates non-FT entries by key prefix', () => {
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['GET', 'user:1'] }),
      entry({ id: 2, command: ['SET', 'user:2', 'v'] }),
      entry({ id: 3, command: ['HGETALL', 'session:abc'] }),
    ]);

    const prefixes = result.byKeyPrefix.map((p) => p.prefix).sort();
    expect(prefixes).toEqual(['session:', 'user:']);
  });
});

describe('analyzeSlowLogPatterns — fullCommand sanitization', () => {
  it('replaces args longer than 200 chars with <blob>', () => {
    const longArg = 'x'.repeat(250);
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['FT.SEARCH', 'idx_cache', 'PARAMS', '2', 'vec', longArg] }),
    ]);

    const example = result.patterns[0].examples[0];
    expect(example.fullCommand).toEqual([
      'FT.SEARCH',
      'idx_cache',
      'PARAMS',
      '2',
      'vec',
      '<blob>',
    ]);
  });

  it('replaces args containing the Unicode replacement character with <blob>', () => {
    const binaryish = 'vec_\uFFFD\uFFFD_bytes';
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['FT.SEARCH', 'idx_cache', 'PARAMS', '2', 'vec', binaryish] }),
    ]);

    const example = result.patterns[0].examples[0];
    expect(example.fullCommand[5]).toBe('<blob>');
  });

  it('replaces args containing non-printable control characters with <blob>', () => {
    const withControl = 'abc\x00\x01\x02def';
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['SET', 'user:1', withControl] }),
    ]);

    const example = result.patterns[0].examples[0];
    expect(example.fullCommand[2]).toBe('<blob>');
  });

  it('leaves short printable args unchanged', () => {
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['GET', 'user:42'] }),
    ]);

    expect(result.patterns[0].examples[0].fullCommand).toEqual(['GET', 'user:42']);
  });

  it('allows common whitespace (newline, tab, CR) inside arg without flagging as binary', () => {
    const multiline = 'line1\nline2\tcol\rend';
    const result = analyzeSlowLogPatterns([
      entry({ id: 1, command: ['SET', 'user:1', multiline] }),
    ]);

    expect(result.patterns[0].examples[0].fullCommand[2]).toBe(multiline);
  });
});

describe('analyzeSlowLogPatterns — existing behavior preserved', () => {
  it('returns empty result for empty input', () => {
    const result = analyzeSlowLogPatterns([]);
    expect(result.totalEntries).toBe(0);
    expect(result.patterns).toEqual([]);
    expect(result.byCommand).toEqual([]);
    expect(result.byKeyPrefix).toEqual([]);
    expect(result.byClient).toEqual([]);
  });

  it('extractKeyPattern and createPatternKey still work', () => {
    expect(extractKeyPattern('user:123')).toBe('user:*');
    expect(createPatternKey('GET', 'user:*')).toBe('GET user:*');
  });
});
