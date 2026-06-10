import { describe, it, expect } from 'vitest';
import { parseDimensionFromInfo, parseFtInfoStats } from '../ft-info';

describe('parseDimensionFromInfo', () => {
  it('parses the flat DIM pair shape', () => {
    const info = [
      'index_name',
      'sc:idx',
      'attributes',
      [['identifier', 'embedding', 'type', 'VECTOR', 'DIM', '1536']],
    ];
    expect(parseDimensionFromInfo(info)).toBe(1536);
  });

  it('parses the nested Valkey Search 1.2 index/dimensions shape', () => {
    const info = [
      'index_name',
      'sc:idx',
      'attributes',
      [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '768']]],
    ];
    expect(parseDimensionFromInfo(info)).toBe(768);
  });

  it('reads attributes under the legacy "fields" key', () => {
    const info = ['fields', [['identifier', 'embedding', 'type', 'VECTOR', 'dim', '384']]];
    expect(parseDimensionFromInfo(info)).toBe(384);
  });

  it('ignores non-vector attributes with a DIM pair', () => {
    const info = ['attributes', [['identifier', 'prompt', 'type', 'TEXT', 'DIM', '99']]];
    expect(parseDimensionFromInfo(info)).toBe(0);
  });

  it('returns 0 when no vector attribute exists', () => {
    const info = ['index_name', 'sc:idx', 'num_docs', '5'];
    expect(parseDimensionFromInfo(info)).toBe(0);
  });
});

describe('parseFtInfoStats', () => {
  it('extracts num_docs and indexing state from flat pairs', () => {
    const info = ['index_name', 'sc:idx', 'num_docs', '42', 'indexing', '0'];
    expect(parseFtInfoStats(info)).toEqual({ numDocs: 42, indexingState: '0' });
  });

  it('defaults to 0 docs and unknown state when keys are absent', () => {
    expect(parseFtInfoStats(['index_name', 'sc:idx'])).toEqual({
      numDocs: 0,
      indexingState: 'unknown',
    });
  });

  it('coerces unparseable num_docs to 0', () => {
    expect(parseFtInfoStats(['num_docs', 'garbage'])).toEqual({
      numDocs: 0,
      indexingState: 'unknown',
    });
  });
});
