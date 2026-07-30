import {
  LOAD_CONSECUTIVE_REQUIRED,
  LOAD_CRIT_FRACTION,
  LOAD_WARN_FRACTION,
  LoadSaturationState,
  acknowledgeLoadSaturationFinding,
  createLoadSaturationState,
  evaluateLoadSaturation,
} from '../load-saturation-detector';

describe('evaluateLoadSaturation', () => {
  const base = 1_700_000_000_000;

  /**
   * Builds an input whose busyFraction equals `fraction`. duration is in
   * microseconds-per-cycle; with 1000 cycles/sec, busyFraction =
   * duration * 1000 / 1e6 = duration / 1000. So duration = fraction * 1000.
   */
  function input(
    over: Partial<Parameters<typeof evaluateLoadSaturation>[1]> & { fraction?: number } = {},
  ) {
    const { fraction, ...rest } = over;
    const cyclesPerSec = rest.eventloopCyclesPerSec ?? 1000;
    const durationFromFraction =
      fraction !== undefined ? (fraction * 1_000_000) / cyclesPerSec : undefined;
    return {
      eventloopDurationUsecPerCycle: durationFromFraction ?? 100,
      eventloopCyclesPerSec: cyclesPerSec,
      cpuUtilizationPct: 90,
      opsPerSec: 50_000,
      timestamp: base,
      ...rest,
    };
  }

  /** Drives N consecutive polls at a given fraction, returning the last finding. */
  function pollN(state: LoadSaturationState, fraction: number, n: number, start = base) {
    let finding = null;
    for (let i = 0; i < n; i += 1) {
      finding = evaluateLoadSaturation(
        state,
        input({ fraction, timestamp: start + i * 1000 }),
      );
    }
    return finding;
  }

  it('stays quiet below the warning threshold', () => {
    const state = createLoadSaturationState();
    for (let i = 0; i < LOAD_CONSECUTIVE_REQUIRED + 2; i += 1) {
      expect(
        evaluateLoadSaturation(state, input({ fraction: 0.5, timestamp: base + i * 1000 })),
      ).toBeNull();
    }
  });

  it('does not fire before N consecutive polls above the warning threshold', () => {
    const state = createLoadSaturationState();
    for (let i = 0; i < LOAD_CONSECUTIVE_REQUIRED - 1; i += 1) {
      expect(
        evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base + i * 1000 })),
      ).toBeNull();
    }
  });

  it('fires WARNING only after N consecutive polls above the warning threshold', () => {
    const state = createLoadSaturationState();
    const finding = pollN(state, 0.85, LOAD_CONSECUTIVE_REQUIRED);
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('warning');
    expect(finding!.busyFraction).toBeCloseTo(0.85);
    expect(finding!.message).toContain('valkey#2055');
    expect(finding!.message).toContain('85.0%');
    expect(finding!.message).toContain('event-loop cycles/sec');
    expect(finding!.message).toContain('ops/sec');
  });

  it('fires CRITICAL once busyness crosses the critical threshold for N polls', () => {
    const state = createLoadSaturationState();
    const finding = pollN(state, 0.97, LOAD_CONSECUTIVE_REQUIRED);
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('critical');
    expect(finding!.message).toContain('CRITICAL');
  });

  it('escalates an acknowledged WARNING to CRITICAL when busyness grows', () => {
    const state = createLoadSaturationState();
    const warn = pollN(state, 0.85, LOAD_CONSECUTIVE_REQUIRED);
    expect(warn!.level).toBe('warning');
    acknowledgeLoadSaturationFinding(state, warn!);

    // Already past the consecutive gate; a single critical poll escalates.
    const crit = evaluateLoadSaturation(
      state,
      input({ fraction: 0.97, timestamp: base + 10_000 }),
    );
    expect(crit).not.toBeNull();
    expect(crit!.level).toBe('critical');
  });

  it('returns null when eventloop duration is missing (older server)', () => {
    const state = createLoadSaturationState();
    const finding = evaluateLoadSaturation(
      state,
      input({ eventloopDurationUsecPerCycle: null, fraction: undefined as unknown as number }),
    );
    expect(finding).toBeNull();
  });

  it('returns null when eventloop cycles are missing (older server)', () => {
    const state = createLoadSaturationState();
    const finding = evaluateLoadSaturation(
      state,
      input({ eventloopCyclesPerSec: null }),
    );
    expect(finding).toBeNull();
  });

  it('a missing-fields poll does not advance the consecutive counter', () => {
    const state = createLoadSaturationState();
    // Two real busy polls, then a poll with the fields absent, then more busy
    // polls — the absent poll must not count toward the streak.
    evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base }));
    evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base + 1000 }));
    expect(
      evaluateLoadSaturation(
        state,
        input({ eventloopDurationUsecPerCycle: null, timestamp: base + 2000 }),
      ),
    ).toBeNull();
    // One more busy poll: streak is at 3 real busy polls now, so it fires.
    const finding = evaluateLoadSaturation(
      state,
      input({ fraction: 0.85, timestamp: base + 3000 }),
    );
    // With LOAD_CONSECUTIVE_REQUIRED === 3 this is exactly the third busy poll.
    if (LOAD_CONSECUTIVE_REQUIRED === 3) {
      expect(finding).not.toBeNull();
    }
    expect(state.consecutive).toBe(3);
  });

  it('resets the consecutive counter when busyness dips below warning', () => {
    const state = createLoadSaturationState();
    evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base }));
    evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base + 1000 }));
    // A dip resets the streak.
    expect(
      evaluateLoadSaturation(state, input({ fraction: 0.4, timestamp: base + 2000 })),
    ).toBeNull();
    expect(state.consecutive).toBe(0);
    // The streak must build up from scratch — two more polls is not enough.
    expect(
      evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base + 3000 })),
    ).toBeNull();
    expect(
      evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base + 4000 })),
    ).toBeNull();
    const finding = evaluateLoadSaturation(
      state,
      input({ fraction: 0.85, timestamp: base + 5000 }),
    );
    expect(finding).not.toBeNull();
  });

  it('keeps returning an unacknowledged finding until acknowledged', () => {
    const state = createLoadSaturationState();
    const first = pollN(state, 0.85, LOAD_CONSECUTIVE_REQUIRED);
    expect(first).not.toBeNull();
    // Not acknowledged: the next steady poll re-returns the finding.
    const again = evaluateLoadSaturation(
      state,
      input({ fraction: 0.85, timestamp: base + 10_000 }),
    );
    expect(again).not.toBeNull();
    expect(again!.level).toBe('warning');
    // Acknowledge, then a steady poll is quiet.
    acknowledgeLoadSaturationFinding(state, again!);
    expect(
      evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base + 11_000 })),
    ).toBeNull();
  });

  it('does not re-emit at the same level once acknowledged (hysteresis)', () => {
    const state = createLoadSaturationState();
    const warn = pollN(state, 0.85, LOAD_CONSECUTIVE_REQUIRED);
    acknowledgeLoadSaturationFinding(state, warn!);
    for (let i = 0; i < 5; i += 1) {
      expect(
        evaluateLoadSaturation(state, input({ fraction: 0.85, timestamp: base + (i + 5) * 1000 })),
      ).toBeNull();
    }
  });

  it('re-arms and fires again after busyness drops and climbs back', () => {
    const state = createLoadSaturationState();
    const warn = pollN(state, 0.85, LOAD_CONSECUTIVE_REQUIRED);
    acknowledgeLoadSaturationFinding(state, warn!);
    // Drop below warning re-arms (ackedLevel back to none).
    expect(
      evaluateLoadSaturation(state, input({ fraction: 0.3, timestamp: base + 10_000 })),
    ).toBeNull();
    // Climb back up for N polls fires a fresh WARNING.
    const again = pollN(state, 0.85, LOAD_CONSECUTIVE_REQUIRED, base + 20_000);
    expect(again).not.toBeNull();
    expect(again!.level).toBe('warning');
  });

  it('notes that CPU% understates the load when CPU sits well below busy fraction', () => {
    const state = createLoadSaturationState();
    // Busy 90%, but CPU reads a low 20% — the #2055 signature.
    const finding = pollN(state, 0.9, LOAD_CONSECUTIVE_REQUIRED);
    // Re-run the last poll with the low CPU explicitly (pollN uses default 90%).
    acknowledgeLoadSaturationFinding(state, finding!);
    // Drop + re-arm so we can re-fire with the low CPU sample.
    evaluateLoadSaturation(state, input({ fraction: 0.2, timestamp: base + 10_000 }));
    let lowCpu = null;
    for (let i = 0; i < LOAD_CONSECUTIVE_REQUIRED; i += 1) {
      lowCpu = evaluateLoadSaturation(
        state,
        input({ fraction: 0.9, cpuUtilizationPct: 20, timestamp: base + 20_000 + i * 1000 }),
      );
    }
    expect(lowCpu).not.toBeNull();
    expect(lowCpu!.message).toContain('UNDERSTATES');
    expect(lowCpu!.message).toContain('20.0%');
  });

  it('does not claim CPU understates the load when CPU tracks the busy fraction', () => {
    const state = createLoadSaturationState();
    let finding = null;
    for (let i = 0; i < LOAD_CONSECUTIVE_REQUIRED; i += 1) {
      finding = evaluateLoadSaturation(
        state,
        input({ fraction: 0.9, cpuUtilizationPct: 88, timestamp: base + i * 1000 }),
      );
    }
    expect(finding).not.toBeNull();
    expect(finding!.message).not.toContain('UNDERSTATES');
  });

  it('omits the CPU clause entirely when no CPU sample is available', () => {
    const state = createLoadSaturationState();
    let finding = null;
    for (let i = 0; i < LOAD_CONSECUTIVE_REQUIRED; i += 1) {
      finding = evaluateLoadSaturation(
        state,
        input({ fraction: 0.9, cpuUtilizationPct: null, timestamp: base + i * 1000 }),
      );
    }
    expect(finding).not.toBeNull();
    expect(finding!.message).not.toContain('CPU utilization');
  });

  it('clamps a busy fraction above 1 (measurement overshoot) to 100%', () => {
    const state = createLoadSaturationState();
    // duration 1500us/cycle * 1000 cycles = 1.5 → clamps to 1.0.
    let finding = null;
    for (let i = 0; i < LOAD_CONSECUTIVE_REQUIRED; i += 1) {
      finding = evaluateLoadSaturation(
        state,
        input({
          eventloopDurationUsecPerCycle: 1500,
          eventloopCyclesPerSec: 1000,
          timestamp: base + i * 1000,
        }),
      );
    }
    expect(finding).not.toBeNull();
    expect(finding!.busyFraction).toBe(1);
    expect(finding!.level).toBe('critical');
    expect(finding!.message).toContain('100.0%');
  });

  it('treats a negative field as unavailable (null), not a fabricated fraction', () => {
    const state = createLoadSaturationState();
    expect(
      evaluateLoadSaturation(state, input({ eventloopDurationUsecPerCycle: -5 })),
    ).toBeNull();
  });

  it('recommends investigating slow commands rather than adding CPU', () => {
    const state = createLoadSaturationState();
    const finding = pollN(state, 0.85, LOAD_CONSECUTIVE_REQUIRED);
    expect(finding!.message).toMatch(/slow commands|O\(N\)|single-thread/);
    expect(finding!.message).toContain('rather than just adding CPU');
  });

  it('exposes the documented thresholds', () => {
    expect(LOAD_WARN_FRACTION).toBe(0.8);
    expect(LOAD_CRIT_FRACTION).toBe(0.95);
  });
});
