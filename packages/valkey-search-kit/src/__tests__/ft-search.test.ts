import { describe, it, expect } from 'vitest';
import { parseFtSearchResponse } from '../ft-search';

describe('parseFtSearchResponse', () => {
  it('returns [] for null', () => {
    expect(parseFtSearchResponse(null)).toEqual([]);
  });

  it('returns [] for empty array', () => {
    expect(parseFtSearchResponse([])).toEqual([]);
  });

  it('returns [] for ["0"]', () => {
    expect(parseFtSearchResponse(['0'])).toEqual([]);
  });

  it('parses a single-entry response', () => {
    const raw = [
      '1',
      'cache:entry:abc',
      ['prompt', 'hello', 'response', 'world', '__score', '0.05'],
    ];
    const result = parseFtSearchResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('cache:entry:abc');
    expect(result[0].fields['prompt']).toBe('hello');
    expect(result[0].fields['response']).toBe('world');
    expect(result[0].fields['__score']).toBe('0.05');
  });

  it('correctly extracts __score from a realistic response', () => {
    const raw = [
      '2',
      'sc:entry:111',
      ['prompt', 'q1', 'response', 'a1', '__score', '0.0234', 'model', 'gpt-4o', 'category', 'faq'],
      'sc:entry:222',
      [
        'prompt',
        'q2',
        'response',
        'a2',
        '__score',
        '0.1500',
        'model',
        'gpt-4o',
        'category',
        'search',
      ],
    ];
    const result = parseFtSearchResponse(raw);
    expect(result).toHaveLength(2);
    expect(parseFloat(result[0].fields['__score'])).toBeCloseTo(0.0234, 4);
    expect(parseFloat(result[1].fields['__score'])).toBeCloseTo(0.15, 4);
  });

  it('returns [] without throwing for a malformed field list (odd-length)', () => {
    const raw = ['1', 'key1', ['field1', 'val1', 'orphan']];
    const result = parseFtSearchResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].fields['field1']).toBe('val1');
    // The orphan field should be skipped
    expect(Object.keys(result[0].fields)).toHaveLength(1);
  });

  it('handles a two-result response', () => {
    const raw = ['2', 'key:a', ['f1', 'v1'], 'key:b', ['f2', 'v2']];
    const result = parseFtSearchResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0].key).toBe('key:a');
    expect(result[0].fields['f1']).toBe('v1');
    expect(result[1].key).toBe('key:b');
    expect(result[1].fields['f2']).toBe('v2');
  });

  it('handles RETURN 0 mode where keys have no field list', () => {
    const raw = ['2', 'key:a', 'key:b'];
    const result = parseFtSearchResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: 'key:a', fields: {} });
    expect(result[1]).toEqual({ key: 'key:b', fields: {} });
  });
});
