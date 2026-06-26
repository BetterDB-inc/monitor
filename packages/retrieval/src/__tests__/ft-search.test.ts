import { describe, it, expect } from 'vitest';
import { buildFtSearchQuery } from '../ft-search';
import type { RetrievalSchema } from '../schema';

const schema: RetrievalSchema = {
  fields: {
    source: { type: 'tag' },
    title: { type: 'text' },
    updated: { type: 'numeric' },
  },
  vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
};

describe('buildFtSearchQuery', () => {
  it('emits a bare KNN query with no filter', () => {
    expect(buildFtSearchQuery(schema, 10)).toBe('*=>[KNN 10 @embedding $vec AS __score]');
  });

  it('wraps a single TAG filter clause', () => {
    expect(buildFtSearchQuery(schema, 5, { source: 'docs' })).toBe(
      '(@source:{docs})=>[KNN 5 @embedding $vec AS __score]',
    );
  });

  it('joins TAG and NUMERIC clauses with AND semantics', () => {
    expect(buildFtSearchQuery(schema, 5, { source: 'docs', updated: 1717200000 })).toBe(
      '(@source:{docs} @updated:[1717200000 1717200000])=>[KNN 5 @embedding $vec AS __score]',
    );
  });

  it('escapes TAG filter values', () => {
    expect(buildFtSearchQuery(schema, 5, { source: 'a:b c' })).toBe(
      '(@source:{a\\:b\\ c})=>[KNN 5 @embedding $vec AS __score]',
    );
  });

  it('throws for a filter on an unknown field', () => {
    expect(() => buildFtSearchQuery(schema, 5, { missing: 'x' })).toThrow(/unknown/i);
  });

  it('throws for a filter on a TEXT field', () => {
    expect(() => buildFtSearchQuery(schema, 5, { title: 'x' })).toThrow(/text/i);
  });

  it('throws when a NUMERIC filter value is not a number', () => {
    expect(() => buildFtSearchQuery(schema, 5, { updated: 'recent' })).toThrow(/numeric/i);
  });

  it('throws when a NUMERIC filter value is not finite', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => buildFtSearchQuery(schema, 5, { updated: value })).toThrow(/finite/i);
    }
  });
});
