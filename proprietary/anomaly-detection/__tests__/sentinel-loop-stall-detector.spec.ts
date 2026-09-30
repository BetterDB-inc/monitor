import {
  DEFAULT_SENTINEL_LOOP_STALL_THRESHOLDS,
  SENTINEL_TILT_TRIGGER_MS,
  SentinelLoopStallInput,
  SentinelLoopStallState,
  createSentinelLoopStallState,
  evaluateSentinelLoopStall,
  sentinelLoopStallSignature,
} from '../sentinel-loop-stall-detector';

/**
 * Unit coverage for the pure loop-stall / TILT detector. Follows
 * sentinel-drift-detector.spec.ts as the style reference: hand-built inputs, one
 * behaviour per test, state threaded explicitly so transitions are exercised.
 */

function input(partial: Partial<SentinelLoopStallInput> = {}): SentinelLoopStallInput {
  return {
    timestamp: 0,
    tiltSinceSeconds: -1,
    tiltFlag: false,
    probeRttMs: 5,
    commandTimedOut: false,
    masterDownObserved: null,
    thresholds: DEFAULT_SENTINEL_LOOP_STALL_THRESHOLDS,
    ...partial,
  };
}

/** Drive `count` polls with the same partial, returning the last poll's findings. */
function driveN(
  state: SentinelLoopStallState,
  partial: Partial<SentinelLoopStallInput>,
  count: number,
) {
  let findings = evaluateSentinelLoopStall(state, input(partial));
  for (let i = 1; i < count; i += 1) {
    findings = evaluateSentinelLoopStall(state, input(partial));
  }
  return findings;
}

describe('evaluateSentinelLoopStall — TILT episode', () => {
  it('fires CRITICAL loop-starvation on entry with the authoritative duration', () => {
    const state = createSentinelLoopStallState();
    const findings = evaluateSentinelLoopStall(state, input({ tiltSinceSeconds: 3 }));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'tilt',
      severity: 'critical',
      classification: 'loop_starvation_dns',
      tiltDurationSeconds: 3,
    });
  });

  it('keeps reporting the same kind while TILT persists (gate dedupes, not the detector)', () => {
    const state = createSentinelLoopStallState();
    evaluateSentinelLoopStall(state, input({ tiltSinceSeconds: 3 }));
    const persist = evaluateSentinelLoopStall(state, input({ tiltSinceSeconds: 8 }));

    expect(persist).toHaveLength(1);
    expect(persist[0].kind).toBe('tilt');
    expect(persist[0].tiltDurationSeconds).toBe(8);
  });

  it('goes quiet on exit and re-arms so a new episode alerts again', () => {
    const state = createSentinelLoopStallState();
    evaluateSentinelLoopStall(state, input({ tiltSinceSeconds: 3 }));

    const exit = evaluateSentinelLoopStall(state, input({ tiltSinceSeconds: -1 }));
    expect(exit).toEqual([]);
    expect(state.inTilt).toBe(false);

    const reentry = evaluateSentinelLoopStall(state, input({ tiltSinceSeconds: 2 }));
    expect(reentry).toHaveLength(1);
    expect(reentry[0].kind).toBe('tilt');
  });

  it('falls back to the tilt flag and its own observed duration on older servers', () => {
    const state = createSentinelLoopStallState();
    const entry = evaluateSentinelLoopStall(
      state,
      input({ tiltSinceSeconds: null, tiltFlag: true, timestamp: 1_000 }),
    );
    expect(entry[0]).toMatchObject({ kind: 'tilt', tiltDurationSeconds: 0 });

    const later = evaluateSentinelLoopStall(
      state,
      input({ tiltSinceSeconds: null, tiltFlag: true, timestamp: 3_500 }),
    );
    expect(later[0].tiltDurationSeconds).toBe(2);
  });

  it('stays silent when neither the tilt seconds nor the flag are present', () => {
    const state = createSentinelLoopStallState();
    expect(
      evaluateSentinelLoopStall(state, input({ tiltSinceSeconds: null, tiltFlag: null })),
    ).toEqual([]);
  });
});

describe('evaluateSentinelLoopStall — RTT proxy', () => {
  it('stays silent below the warn threshold', () => {
    const state = createSentinelLoopStallState();
    const findings = driveN(state, { probeRttMs: 50 }, 10);
    expect(findings).toEqual([]);
  });

  it('raises a WARNING once K of N samples cross the warn threshold', () => {
    const state = createSentinelLoopStallState();
    // Two breaches: below K (=3), no finding yet.
    expect(evaluateSentinelLoopStall(state, input({ probeRttMs: 1_600 }))).toEqual([]);
    expect(evaluateSentinelLoopStall(state, input({ probeRttMs: 1_600 }))).toEqual([]);
    // Third breach reaches K.
    const findings = evaluateSentinelLoopStall(state, input({ probeRttMs: 1_600 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'rtt_stall',
      severity: 'warning',
      classification: 'loop_starvation_dns',
    });
    expect(findings[0].observedRttMs).toBe(1_600);
  });

  it('escalates to CRITICAL when the breaches exceed the TILT trigger', () => {
    const state = createSentinelLoopStallState();
    const findings = driveN(state, { probeRttMs: SENTINEL_TILT_TRIGGER_MS + 100 }, 3);
    expect(findings[0]).toMatchObject({ kind: 'rtt_stall', severity: 'critical' });
  });

  it('re-arms once the spikes age out of the window', () => {
    const state = createSentinelLoopStallState();
    driveN(state, { probeRttMs: 1_600 }, 3);
    // A full window of healthy samples evicts every breach.
    const healthy = driveN(state, { probeRttMs: 20 }, 10);
    expect(healthy).toEqual([]);
  });
});

describe('evaluateSentinelLoopStall — total wedge', () => {
  it('reports a CRITICAL wedge when INFO times out while TCP stays up', () => {
    const state = createSentinelLoopStallState();
    const findings = evaluateSentinelLoopStall(
      state,
      input({ commandTimedOut: true, probeRttMs: null }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'timeout_wedge',
      severity: 'critical',
      classification: 'loop_starvation_dns',
    });
  });

  it('does not add a sample from a timed-out poll', () => {
    const state = createSentinelLoopStallState();
    evaluateSentinelLoopStall(state, input({ commandTimedOut: true, probeRttMs: null }));
    expect(state.rttSamples).toEqual([]);
  });
});

describe('evaluateSentinelLoopStall — misdirected resolution (split-horizon)', () => {
  it('classifies sdown with a healthy flat loop as misdirected, after the streak of fresh observations', () => {
    const state = createSentinelLoopStallState();
    const thresholds = DEFAULT_SENTINEL_LOOP_STALL_THRESHOLDS;

    // Below the streak: silent. Each `true` is one FRESH observation.
    for (let i = 1; i < thresholds.misdirectedMinStreak; i += 1) {
      expect(
        evaluateSentinelLoopStall(state, input({ masterDownObserved: true, probeRttMs: 10 })),
      ).toEqual([]);
    }
    const findings = evaluateSentinelLoopStall(
      state,
      input({ masterDownObserved: true, probeRttMs: 10 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'misdirected_resolution',
      severity: 'warning',
      classification: 'misdirected_resolution',
    });
  });

  it('holds the streak on a null (stale) observation so a stale snapshot cannot advance it', () => {
    const state = createSentinelLoopStallState();
    // Two fresh down observations, then many stale polls (null) between refreshes.
    evaluateSentinelLoopStall(state, input({ masterDownObserved: true, probeRttMs: 10 }));
    evaluateSentinelLoopStall(state, input({ masterDownObserved: true, probeRttMs: 10 }));
    expect(state.misdirectedStreak).toBe(2);
    const held = driveN(state, { masterDownObserved: null, probeRttMs: 10 }, 20);
    expect(held).toEqual([]);
    expect(state.misdirectedStreak).toBe(2);
    // Only the next FRESH down observation advances it to the threshold.
    const findings = evaluateSentinelLoopStall(
      state,
      input({ masterDownObserved: true, probeRttMs: 10 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('misdirected_resolution');
  });

  it('resets the streak on a recovered master so a transient failover sdown never alerts', () => {
    const state = createSentinelLoopStallState();
    driveN(state, { masterDownObserved: true, probeRttMs: 10 }, 2);
    // Master recovers (a fresh `false`) before the streak completes.
    evaluateSentinelLoopStall(state, input({ masterDownObserved: false, probeRttMs: 10 }));
    expect(state.misdirectedStreak).toBe(0);
    const findings = driveN(state, { masterDownObserved: true, probeRttMs: 10 }, 2);
    expect(findings).toEqual([]);
  });

  it('prefers the loop-starvation reading when the loop is ALSO stalling', () => {
    const state = createSentinelLoopStallState();
    // sdown AND an RTT stall: a stall outranks the split-horizon reading, and the
    // misdirected streak must not accumulate underneath it.
    const findings = driveN(state, { masterDownObserved: true, probeRttMs: 1_600 }, 3);
    expect(findings[0].kind).toBe('rtt_stall');
    expect(state.misdirectedStreak).toBe(0);
  });

  it('prefers TILT over the split-horizon reading', () => {
    const state = createSentinelLoopStallState();
    const findings = evaluateSentinelLoopStall(
      state,
      input({ masterDownObserved: true, tiltSinceSeconds: 5 }),
    );
    expect(findings[0].kind).toBe('tilt');
    expect(state.misdirectedStreak).toBe(0);
  });
});

describe('sentinelLoopStallSignature', () => {
  it('is distinct per kind and stable per kind', () => {
    const tilt = sentinelLoopStallSignature({
      kind: 'tilt',
      severity: 'critical',
      classification: 'loop_starvation_dns',
      tiltDurationSeconds: 3,
      observedRttMs: null,
      breachCount: 0,
    });
    const rtt = sentinelLoopStallSignature({
      kind: 'rtt_stall',
      severity: 'warning',
      classification: 'loop_starvation_dns',
      tiltDurationSeconds: null,
      observedRttMs: 1_600,
      breachCount: 3,
    });
    expect(tilt).not.toBe(rtt);
    // Duration/RTT are NOT in the signature, so a growing episode dedupes.
    expect(tilt).toBe(
      sentinelLoopStallSignature({
        kind: 'tilt',
        severity: 'critical',
        classification: 'loop_starvation_dns',
        tiltDurationSeconds: 99,
        observedRttMs: 12,
        breachCount: 4,
      }),
    );
  });
});
