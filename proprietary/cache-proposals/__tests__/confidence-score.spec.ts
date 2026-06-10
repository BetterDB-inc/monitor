import {
  computeConfidence,
  signalBoundaryFor,
  TARGET_SAMPLES,
  SIGNAL_SAT,
  FRESHNESS_WINDOW_MS,
  TIGHTEN_BOUNDARY,
  DISTANT_HITS_BOUNDARY,
  LOOSEN_BOUNDARY,
  LOW_HIT_RATE_BOUNDARY,
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

describe('signalBoundaryFor', () => {
  it('returns the matching boundary for each known signal', () => {
    expect(signalBoundaryFor('uncertain_hits')).toBe(TIGHTEN_BOUNDARY);
    expect(signalBoundaryFor('distant_hits')).toBe(DISTANT_HITS_BOUNDARY);
    expect(signalBoundaryFor('near_misses')).toBe(LOOSEN_BOUNDARY);
    expect(signalBoundaryFor('low_hit_rate')).toBe(LOW_HIT_RATE_BOUNDARY);
  });

  it('returns null for unknown or undefined signals', () => {
    expect(signalBoundaryFor(undefined)).toBeNull();
    expect(signalBoundaryFor('')).toBeNull();
    expect(signalBoundaryFor('typo_signal')).toBeNull();
  });
});

describe('regression: mapping bug repro (PR #224 review by KIvanow)', () => {
  // The original wiring passed signalRate=nearMissRate / boundary=LOOSEN_BOUNDARY
  // for ALL LOOSEN paths, including low_hit_rate. On the low_hit_rate path the
  // engine has already fallen through `nearMissRate > 0.25`, so the rate is
  // below the boundary — the signal component collapses to 0 → whole score 0.
  // These two tests show the math is correct given inputs; the bug was the
  // mapping that fed the wrong inputs.
  const now = 1_700_000_000_000;
  const freshFullSamples = {
    sampleCount: TARGET_SAMPLES,
    latestRecordedAt: now,
    now,
  };

  it('low_hit_rate path: passing nearMissRate (below LOOSEN_BOUNDARY) yields signal=0 / score=0', () => {
    // Simulate the buggy wiring on a low_hit_rate triggered LOOSEN where
    // nearMissRate happens to be 0.10 — well below the 0.25 LOOSEN_BOUNDARY.
    const buggy = computeConfidence({
      ...freshFullSamples,
      signalRate: 0.1,
      signalBoundary: LOOSEN_BOUNDARY,
    });
    expect(buggy.breakdown.signal).toBe(0);
    expect(buggy.score).toBe(0);

    // Correct wiring on the same engine state: closeMissFraction = 0.5,
    // boundary = LOW_HIT_RATE_BOUNDARY (0.1). Now there's a real signal.
    const fixed = computeConfidence({
      ...freshFullSamples,
      signalRate: 0.5,
      signalBoundary: LOW_HIT_RATE_BOUNDARY,
    });
    expect(fixed.breakdown.signal).toBeGreaterThan(0);
    expect(fixed.score).toBeGreaterThan(0);
  });

  it('distant_hits path: passing uncertainHitRate (below TIGHTEN_BOUNDARY) yields signal=0 / score=0', () => {
    // Symmetric: distant_hits TIGHTEN fires when uncertainHitRate ≤ 0.2 but
    // distantHitRate > 0.25. Buggy wiring passed uncertainHitRate to the
    // confidence calc.
    const buggy = computeConfidence({
      ...freshFullSamples,
      signalRate: 0.15,
      signalBoundary: TIGHTEN_BOUNDARY,
    });
    expect(buggy.breakdown.signal).toBe(0);
    expect(buggy.score).toBe(0);

    const fixed = computeConfidence({
      ...freshFullSamples,
      signalRate: 0.4,
      signalBoundary: DISTANT_HITS_BOUNDARY,
    });
    expect(fixed.breakdown.signal).toBeGreaterThan(0);
    expect(fixed.score).toBeGreaterThan(0);
  });
});
