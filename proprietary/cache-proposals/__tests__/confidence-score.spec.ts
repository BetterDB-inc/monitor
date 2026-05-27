import {
  computeConfidence,
  TARGET_SAMPLES,
  SIGNAL_SAT,
  FRESHNESS_WINDOW_MS,
  TIGHTEN_BOUNDARY,
  LOOSEN_BOUNDARY,
} from '../confidence-score';

describe('computeConfidence', () => {
  const now = 1_700_000_000_000;
  const baseInput = {
    sampleCount: TARGET_SAMPLES,
    signalRate: SIGNAL_SAT,
    signalBoundary: TIGHTEN_BOUNDARY,
    latestRecordedAt: now,
    now,
  };

  it('returns 1.0 score when every component is saturated', () => {
    const result = computeConfidence(baseInput);
    expect(result.score).toBeCloseTo(1.0, 5);
    expect(result.breakdown).toEqual({ sample: 1, signal: 1, freshness: 1 });
  });

  it('drives score toward 0 when signal is at the decision boundary', () => {
    const result = computeConfidence({ ...baseInput, signalRate: TIGHTEN_BOUNDARY });
    expect(result.breakdown.signal).toBe(0);
    expect(result.score).toBe(0);
  });

  it('caps sample component at 1 past TARGET_SAMPLES', () => {
    const result = computeConfidence({ ...baseInput, sampleCount: TARGET_SAMPLES * 10 });
    expect(result.breakdown.sample).toBe(1);
  });

  it('scales sample component linearly below TARGET_SAMPLES', () => {
    const result = computeConfidence({ ...baseInput, sampleCount: TARGET_SAMPLES / 2 });
    expect(result.breakdown.sample).toBeCloseTo(0.5, 5);
  });

  it('reports 0 freshness when samples are older than FRESHNESS_WINDOW_MS', () => {
    const result = computeConfidence({
      ...baseInput,
      latestRecordedAt: now - FRESHNESS_WINDOW_MS - 1,
    });
    expect(result.breakdown.freshness).toBe(0);
    expect(result.score).toBe(0);
  });

  it('clamps freshness to 1 under clock skew (latestRecordedAt > now)', () => {
    const result = computeConfidence({
      ...baseInput,
      latestRecordedAt: now + 10_000,
    });
    expect(result.breakdown.freshness).toBe(1);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('short-circuits to 0 when sampleCount is 0', () => {
    const result = computeConfidence({ ...baseInput, sampleCount: 0 });
    expect(result.score).toBe(0);
    expect(result.breakdown).toEqual({ sample: 0, signal: 1, freshness: 1 });
  });

  it('uses the LOOSEN boundary correctly', () => {
    const result = computeConfidence({
      ...baseInput,
      signalRate: LOOSEN_BOUNDARY,
      signalBoundary: LOOSEN_BOUNDARY,
    });
    expect(result.breakdown.signal).toBe(0);
  });

  it('always returns components in [0, 1] regardless of input', () => {
    const result = computeConfidence({
      ...baseInput,
      sampleCount: -10,
      signalRate: 5,
      latestRecordedAt: now - FRESHNESS_WINDOW_MS * 100,
    });
    for (const v of Object.values(result.breakdown)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
