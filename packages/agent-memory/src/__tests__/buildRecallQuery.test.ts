import { describe, it, expect } from 'vitest';
import { buildRecallQuery, buildConsolidateFilter } from '../buildRecallQuery';

describe('buildRecallQuery', () => {
  it('builds a bare KNN query when there are no filters', () => {
    expect(buildRecallQuery(32, {}, [])).toBe('*=>[KNN 32 @vector $vec AS __score]');
  });

  it('filters by scope and tags with AND semantics', () => {
    expect(buildRecallQuery(8, { threadId: 't1', namespace: 'user:1' }, ['pref'])).toBe(
      '(@threadId:{t1} @namespace:{user\\:1} @tags:{pref})=>[KNN 8 @vector $vec AS __score]',
    );
  });

  it('escapes scope and tag values', () => {
    expect(buildRecallQuery(8, { agentId: 'a:b' }, ['x y'])).toBe(
      '(@agentId:{a\\:b} @tags:{x\\ y})=>[KNN 8 @vector $vec AS __score]',
    );
  });
});

describe('buildConsolidateFilter', () => {
  it('appends inclusive NUMERIC ranges and a source exclusion to the scope filter', () => {
    expect(
      buildConsolidateFilter({ namespace: 'u1' }, ['pref'], {
        maxCreatedAt: 1000,
        maxImportance: 0.5,
        excludeSource: 'summary',
      }),
    ).toBe('(@namespace:{u1} @tags:{pref} @created_at:[-inf 1000] @importance:[-inf 0.5] -@source:{summary})');
  });

  it('omits absent predicates', () => {
    expect(buildConsolidateFilter({ threadId: 't' }, [], { excludeSource: 'summary' })).toBe(
      '(@threadId:{t} -@source:{summary})',
    );
  });

  it('still constrains by range when there is no scope', () => {
    expect(buildConsolidateFilter({}, [], { maxImportance: 0.3 })).toBe('(@importance:[-inf 0.3])');
  });
});
