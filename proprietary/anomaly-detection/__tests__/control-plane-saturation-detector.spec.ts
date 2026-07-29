import {
  CONTROL_PLANE_CORROBORATING_METRICS,
  SATURATION_CPU_PCT,
  SATURATION_MIN_STREAK,
  acknowledgeSaturationFinding,
  createControlPlaneSaturationEvent,
  createControlPlaneState,
  evaluateControlPlaneSaturation,
  isControlPlaneSaturationEvent,
} from '../control-plane-saturation-detector';
import { MetricType } from '../types';

describe('evaluateControlPlaneSaturation', () => {
  const base = 1_700_000_000_000;

  function input(over: Partial<Parameters<typeof evaluateControlPlaneSaturation>[1]> = {}) {
    return {
      cpuUtilization: 95,
      cpuCounterReset: false,
      probeRttMs: 10,
      replicaDropCount: 0,
      recentControlPlaneEvents: [],
      timestamp: base,
      ...over,
    };
  }

  function warmRtt(state: ReturnType<typeof createControlPlaneState>) {
    for (let i = 0; i < 10; i++) {
      evaluateControlPlaneSaturation(
        state,
        input({ cpuUtilization: 10, timestamp: base - (20 - i) * 10_000 }),
      );
    }
  }

  it('never fires on sustained high CPU without corroboration', () => {
    const state = createControlPlaneState();
    for (let i = 0; i < 10; i++) {
      const finding = evaluateControlPlaneSaturation(
        state,
        input({ timestamp: base + i * 10_000 }),
      );
      expect(finding).toBeNull();
    }
  });

  it('never fires on an RTT spike without high CPU', () => {
    const state = createControlPlaneState();
    warmRtt(state);
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ cpuUtilization: 20, probeRttMs: 800 }),
    );
    expect(finding).toBeNull();
  });

  it('fires after the CPU streak with a corroborating recent event', () => {
    const state = createControlPlaneState();
    expect(evaluateControlPlaneSaturation(state, input({ timestamp: base }))).toBeNull();
    expect(evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }))).toBeNull();
    const finding = evaluateControlPlaneSaturation(
      state,
      input({
        timestamp: base + 20_000,
        recentControlPlaneEvents: [
          { metricType: MetricType.REPLICATION_ROLE, timestamp: base + 15_000 },
        ],
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding?.message).toContain('valkey#3927');
    expect(finding?.message).toContain('CPU saturation');
    expect(finding?.corroboration).toContain('replication_role');
  });

  it('fires with a multi-replica drop as the corroborator', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 20_000, replicaDropCount: 2 }),
    );
    expect(finding).not.toBeNull();
    expect(finding?.corroboration).toContain('replica');
  });

  it('fires on repeated single drops accumulating in the window', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base, replicaDropCount: 1 }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 20_000, replicaDropCount: 1 }),
    );
    expect(finding).not.toBeNull();
    expect(finding?.corroboration).toContain('replica');
  });

  it('does not fire on a lone single-replica drop under busy-but-healthy CPU (maintenance)', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 20_000, replicaDropCount: 1 }),
    );
    expect(finding).toBeNull();
    expect(
      evaluateControlPlaneSaturation(state, input({ timestamp: base + 30_000 })),
    ).toBeNull();
  });

  it('a single drop corroborates alongside a second signal', () => {
    const state = createControlPlaneState();
    warmRtt(state);
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 20_000, replicaDropCount: 1, probeRttMs: 900 }),
    );
    expect(finding).not.toBeNull();
    expect(finding?.corroboration).toContain('RTT');
    expect(finding?.corroboration).toContain('replica');
  });

  it('fires with a probe-RTT spike against the rolling baseline as the corroborator', () => {
    const state = createControlPlaneState();
    warmRtt(state);
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 20_000, probeRttMs: 900 }),
    );
    expect(finding).not.toBeNull();
    expect(finding?.corroboration).toContain('RTT');
  });

  it('an RTT spike below the floor never corroborates', () => {
    const state = createControlPlaneState();
    for (let i = 0; i < 10; i++) {
      evaluateControlPlaneSaturation(
        state,
        input({ cpuUtilization: 10, probeRttMs: 2, timestamp: base - (20 - i) * 10_000 }),
      );
    }
    evaluateControlPlaneSaturation(state, input({ probeRttMs: 2, timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ probeRttMs: 2, timestamp: base + 10_000 }));
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ probeRttMs: 40, timestamp: base + 20_000 }),
    );
    expect(finding).toBeNull();
  });

  it('keeps returning the finding until acknowledged, then goes quiet for the episode', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const first = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 20_000, replicaDropCount: 2 }),
    );
    expect(first).not.toBeNull();
    const second = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 30_000, replicaDropCount: 2 }),
    );
    expect(second).not.toBeNull();
    acknowledgeSaturationFinding(state, base + 30_000);
    const third = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 40_000, replicaDropCount: 2 }),
    );
    expect(third).toBeNull();
  });

  it('re-arms only after the CPU streak fully resets (recovery + re-trigger)', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const first = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 20_000, replicaDropCount: 2 }),
    );
    expect(first).not.toBeNull();
    acknowledgeSaturationFinding(state, base + 20_000);

    evaluateControlPlaneSaturation(state, input({ cpuUtilization: 30, timestamp: base + 30_000 }));

    evaluateControlPlaneSaturation(state, input({ timestamp: base + 40_000 }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 50_000 }));
    const again = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 60_000, replicaDropCount: 2 }),
    );
    expect(again).not.toBeNull();
  });

  it("does not re-fire off the previous episode's evidence after CPU chatter", () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const staleEvent = [{ metricType: MetricType.REPLICATION_ROLE, timestamp: base + 15_000 }];
    const first = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 20_000, replicaDropCount: 1, recentControlPlaneEvents: staleEvent }),
    );
    expect(first).not.toBeNull();
    acknowledgeSaturationFinding(state, base + 20_000);

    // a single below-threshold poll resets the streak (episode re-armed)…
    evaluateControlPlaneSaturation(state, input({ cpuUtilization: 30, timestamp: base + 30_000 }));
    // …then CPU climbs again, but the only evidence predates the last fire
    evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 40_000, recentControlPlaneEvents: staleEvent }),
    );
    evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 50_000, recentControlPlaneEvents: staleEvent }),
    );
    const refire = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 60_000, recentControlPlaneEvents: staleEvent }),
    );
    expect(refire).toBeNull();

    // fresh impact evidence fires a genuine new episode
    const fresh = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 70_000, replicaDropCount: 2 }),
    );
    expect(fresh).not.toBeNull();
  });

  it('a replica drop early in the streak buildup still corroborates at the threshold', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base, replicaDropCount: 2 }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    const finding = evaluateControlPlaneSaturation(state, input({ timestamp: base + 20_000 }));
    expect(finding).not.toBeNull();
    expect(finding?.corroboration).toContain('replica');
  });

  it('a replica drop older than the corroboration window no longer corroborates', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base, replicaDropCount: 2 }));
    const late = base + 120_000;
    evaluateControlPlaneSaturation(state, input({ timestamp: late }));
    evaluateControlPlaneSaturation(state, input({ timestamp: late + 10_000 }));
    const finding = evaluateControlPlaneSaturation(state, input({ timestamp: late + 20_000 }));
    expect(finding).toBeNull();
  });

  it('a CPU counter reset (restart) ends the episode: streak and drop memory cleared', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base, replicaDropCount: 2 }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    evaluateControlPlaneSaturation(
      state,
      input({ cpuUtilization: null, cpuCounterReset: true, timestamp: base + 20_000 }),
    );
    expect(evaluateControlPlaneSaturation(state, input({ timestamp: base + 30_000 }))).toBeNull();
    expect(evaluateControlPlaneSaturation(state, input({ timestamp: base + 40_000 }))).toBeNull();
    const finding = evaluateControlPlaneSaturation(state, input({ timestamp: base + 50_000 }));
    expect(finding).toBeNull();
  });

  it('post-restart latency is not judged against the old process RTT baseline', () => {
    const state = createControlPlaneState();
    warmRtt(state);
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    evaluateControlPlaneSaturation(
      state,
      input({ cpuUtilization: null, cpuCounterReset: true, timestamp: base + 20_000 }),
    );
    // startup load: CPU pinned and INFO slow, judged only against fresh samples
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 30_000, probeRttMs: 900 }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 40_000, probeRttMs: 900 }));
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 50_000, probeRttMs: 900 }),
    );
    expect(finding).toBeNull();
  });

  it('restart-window anomaly events do not corroborate a post-restart streak', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    evaluateControlPlaneSaturation(
      state,
      input({ cpuUtilization: null, cpuCounterReset: true, timestamp: base + 20_000 }),
    );
    // failover events raised by the restart itself, still inside the window
    const restartFallout = [
      { metricType: MetricType.REPLICATION_ROLE, timestamp: base + 19_000 },
      { metricType: MetricType.CLUSTER_STATE, timestamp: base + 20_000 },
    ];
    evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 30_000, recentControlPlaneEvents: restartFallout }),
    );
    evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 40_000, recentControlPlaneEvents: restartFallout }),
    );
    const stale = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 50_000, recentControlPlaneEvents: restartFallout }),
    );
    expect(stale).toBeNull();

    // an event raised after the restart is genuine evidence
    const fresh = evaluateControlPlaneSaturation(
      state,
      input({
        timestamp: base + 60_000,
        recentControlPlaneEvents: [
          { metricType: MetricType.REPL_BUFFER_PRESSURE, timestamp: base + 55_000 },
        ],
      }),
    );
    expect(fresh).not.toBeNull();
  });

  it('a null CPU sample carries the streak without advancing it', () => {
    const state = createControlPlaneState();
    evaluateControlPlaneSaturation(state, input({ timestamp: base }));
    evaluateControlPlaneSaturation(state, input({ timestamp: base + 10_000 }));
    evaluateControlPlaneSaturation(
      state,
      input({ cpuUtilization: null, timestamp: base + 20_000 }),
    );
    const finding = evaluateControlPlaneSaturation(
      state,
      input({ timestamp: base + 30_000, replicaDropCount: 2 }),
    );
    expect(finding).not.toBeNull();
  });
});

describe('isControlPlaneSaturationEvent', () => {
  const saturationEvent = createControlPlaneSaturationEvent(
    { cpuUtilization: 97, corroboration: 'probe RTT spike', message: 'saturation' },
    'x',
    1,
    undefined,
  );

  it('matches the constructor-built synthetic event', () => {
    expect(isControlPlaneSaturationEvent(saturationEvent)).toBe(true);
  });

  it('does not match a z-score CPU anomaly', () => {
    const { syntheticPattern: ignored, ...rest } = saturationEvent;
    expect(isControlPlaneSaturationEvent({ ...rest, zScore: 4.2, threshold: 3 })).toBe(false);
  });

  it('does not match an unmarked CPU anomaly that collides on the numeric shape', () => {
    // value == mean == 90 under a hypothetical criticalThreshold: 90 CPU
    // config produces exactly zScore 0 / threshold 90 — the shape the old
    // sniff misclassified.
    const { syntheticPattern: ignored, ...rest } = saturationEvent;
    expect(
      isControlPlaneSaturationEvent({ ...rest, value: 90, zScore: 0, threshold: 90 }),
    ).toBe(false);
  });

});

describe('constants', () => {
  it('exposes the documented defaults', () => {
    expect(SATURATION_CPU_PCT).toBe(90);
    expect(SATURATION_MIN_STREAK).toBe(3);
  });

});
