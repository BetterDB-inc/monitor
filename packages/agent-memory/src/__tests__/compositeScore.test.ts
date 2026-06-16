import { describe, it, expect } from 'vitest';
import { compositeScore } from '../compositeScore';

const W = { similarity: 0.6, recency: 0.25, importance: 0.15 };
const HALF = 604800; // 7 days

describe('compositeScore', () => {
  it('decays recency to ~0.5 at one half-life', () => {
    const score = compositeScore({
      similarity: 0,
      importance: 0,
      ageSeconds: HALF,
      weights: { similarity: 0, recency: 1, importance: 0 },
      halfLifeSeconds: HALF,
    });
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('combines weighted similarity, recency, and importance', () => {
    const score = compositeScore({
      similarity: 1,
      importance: 1,
      ageSeconds: 0,
      weights: W,
      halfLifeSeconds: HALF,
    });
    expect(score).toBeCloseTo(1, 5);
  });

  it('ranks an identical recent match above a distant one', () => {
    const identical = compositeScore({
      similarity: 1,
      importance: 0.5,
      ageSeconds: 0,
      weights: W,
      halfLifeSeconds: HALF,
    });
    const distant = compositeScore({
      similarity: 0.2,
      importance: 0.5,
      ageSeconds: 0,
      weights: W,
      halfLifeSeconds: HALF,
    });
    expect(identical).toBeGreaterThan(distant);
  });

  it('lets recency promote a recent-but-weaker item over an old-but-closer one', () => {
    const recentWeaker = compositeScore({
      similarity: 0.6,
      importance: 0.5,
      ageSeconds: 0,
      weights: W,
      halfLifeSeconds: HALF,
    });
    const oldCloser = compositeScore({
      similarity: 0.8,
      importance: 0.5,
      ageSeconds: HALF * 5,
      weights: W,
      halfLifeSeconds: HALF,
    });
    expect(recentWeaker).toBeGreaterThan(oldCloser);
  });

  it('breaks ties by importance', () => {
    const base = { similarity: 0.5, ageSeconds: 0, weights: W, halfLifeSeconds: HALF };
    const high = compositeScore({ ...base, importance: 0.9 });
    const low = compositeScore({ ...base, importance: 0.1 });
    expect(high).toBeGreaterThan(low);
  });
});
