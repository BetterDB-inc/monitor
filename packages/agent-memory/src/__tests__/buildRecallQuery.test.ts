import { describe, it, expect } from 'vitest';
import { buildRecallQuery } from '../buildRecallQuery';

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
