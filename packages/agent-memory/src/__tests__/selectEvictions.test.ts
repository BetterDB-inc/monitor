import { describe, it, expect } from 'vitest';
import { selectEvictions, type EvictionCandidate } from '../selectEvictions';

const HALF_LIFE = 604800;
const now = 1_000_000_000_000;
const weights = { similarity: 0.6, recency: 0.25, importance: 0.15 };

function candidate(key: string, importance: number, ageSeconds: number): EvictionCandidate {
  return { key, importance, lastAccessedAt: now - ageSeconds * 1000 };
}

describe('selectEvictions', () => {
  it('evicts nothing when the scope is at or under capacity', () => {
    const items = [candidate('a', 0.1, 0), candidate('b', 0.9, 0)];
    expect(selectEvictions(items, 2, { now, halfLifeSeconds: HALF_LIFE, weights })).toEqual([]);
    expect(selectEvictions(items, 5, { now, halfLifeSeconds: HALF_LIFE, weights })).toEqual([]);
  });

  it('drops exactly (count - max) items', () => {
    const items = [
      candidate('a', 0.1, 0),
      candidate('b', 0.2, 0),
      candidate('c', 0.3, 0),
      candidate('d', 0.4, 0),
    ];
    const evicted = selectEvictions(items, 2, { now, halfLifeSeconds: HALF_LIFE, weights });
    expect(evicted).toHaveLength(2);
  });

  it('evicts the lowest-importance items when recency is equal', () => {
    const items = [candidate('low', 0.1, 0), candidate('mid', 0.5, 0), candidate('high', 0.9, 0)];
    const evicted = selectEvictions(items, 1, { now, halfLifeSeconds: HALF_LIFE, weights });
    expect(evicted).toEqual(['low', 'mid']);
  });

  it('evicts the oldest items when importance is equal', () => {
    const items = [
      candidate('fresh', 0.5, 0),
      candidate('week', 0.5, HALF_LIFE),
      candidate('ancient', 0.5, HALF_LIFE * 4),
    ];
    const evicted = selectEvictions(items, 1, { now, halfLifeSeconds: HALF_LIFE, weights });
    expect(evicted).toEqual(['ancient', 'week']);
  });

  it('lets a fresh low-importance item outrank a stale high-importance one when recency dominates', () => {
    const recencyHeavy = { similarity: 0, recency: 0.9, importance: 0.1 };
    const items = [
      candidate('staleImportant', 0.9, HALF_LIFE * 6),
      candidate('freshTrivial', 0.1, 0),
    ];
    const evicted = selectEvictions(items, 1, {
      now,
      halfLifeSeconds: HALF_LIFE,
      weights: recencyHeavy,
    });
    expect(evicted).toEqual(['staleImportant']);
  });

  it('returns every key when max is zero', () => {
    const items = [candidate('a', 0.5, 0), candidate('b', 0.5, 10)];
    const evicted = selectEvictions(items, 0, { now, halfLifeSeconds: HALF_LIFE, weights });
    expect(evicted.sort()).toEqual(['a', 'b']);
  });
});
