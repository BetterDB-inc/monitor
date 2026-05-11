import {
  DEFAULT_HEALTH_GATE_THRESHOLDS,
  HealthGateSignals,
  HealthGateThresholds,
  evaluateHealthGate,
  thresholdsFromEnv,
} from '../health-gate';

const HEALTHY_SIGNALS: HealthGateSignals = {
  memoryPct: 0.4,
  oomEventsRecent: 0,
  replicationLagBytes: 0,
  failoverInProgress: false,
};

describe('evaluateHealthGate', () => {
  it('allows the capture when every signal is below threshold', () => {
    const result = evaluateHealthGate(HEALTHY_SIGNALS);
    expect(result.allow).toBe(true);
    expect(result.skipReason).toBeUndefined();
    expect(result.signals).toEqual(HEALTHY_SIGNALS);
    expect(result.thresholds).toEqual(DEFAULT_HEALTH_GATE_THRESHOLDS);
  });

  describe('memory pressure signal', () => {
    it('skips when memoryPct is at the threshold (>=)', () => {
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, memoryPct: 0.85 });
      expect(result).toMatchObject({ allow: false, skipReason: 'memory_above_threshold' });
    });

    it('skips when memoryPct exceeds the threshold', () => {
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, memoryPct: 0.92 });
      expect(result).toMatchObject({ allow: false, skipReason: 'memory_above_threshold' });
    });

    it('allows when memoryPct is just below the threshold', () => {
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, memoryPct: 0.8499 });
      expect(result.allow).toBe(true);
    });

    it('respects an overridden memory threshold', () => {
      const tighter: HealthGateThresholds = { ...DEFAULT_HEALTH_GATE_THRESHOLDS, memoryPctThreshold: 0.5 };
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, memoryPct: 0.6 }, tighter);
      expect(result).toMatchObject({ allow: false, skipReason: 'memory_above_threshold' });
    });
  });

  describe('recent OOM signal', () => {
    it('skips when one or more OOM events occurred in the recent window', () => {
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, oomEventsRecent: 1 });
      expect(result).toMatchObject({ allow: false, skipReason: 'recent_oom' });
    });

    it('allows when no OOM events occurred in the window', () => {
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, oomEventsRecent: 0 });
      expect(result.allow).toBe(true);
    });
  });

  describe('failover signal', () => {
    it('skips when a failover is in progress', () => {
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, failoverInProgress: true });
      expect(result).toMatchObject({ allow: false, skipReason: 'failover_in_progress' });
    });

    it('allows when no failover is in progress', () => {
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, failoverInProgress: false });
      expect(result.allow).toBe(true);
    });
  });

  describe('replication lag signal', () => {
    it('skips when lag is at or above the threshold', () => {
      const result = evaluateHealthGate({
        ...HEALTHY_SIGNALS,
        replicationLagBytes: 10 * 1024 * 1024,
      });
      expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
    });

    it('allows when lag is below the threshold', () => {
      const result = evaluateHealthGate({ ...HEALTHY_SIGNALS, replicationLagBytes: 1024 * 1024 });
      expect(result.allow).toBe(true);
    });

    it('respects an overridden lag threshold', () => {
      const tighter: HealthGateThresholds = {
        ...DEFAULT_HEALTH_GATE_THRESHOLDS,
        replicationLagThresholdBytes: 1024,
      };
      const result = evaluateHealthGate(
        { ...HEALTHY_SIGNALS, replicationLagBytes: 4096 },
        tighter,
      );
      expect(result).toMatchObject({ allow: false, skipReason: 'replication_lag_elevated' });
    });
  });

  describe('reason ordering when multiple signals trip', () => {
    it('reports memory pressure before recent OOM', () => {
      const result = evaluateHealthGate({
        memoryPct: 0.95,
        oomEventsRecent: 3,
        replicationLagBytes: 0,
        failoverInProgress: false,
      });
      expect(result.skipReason).toBe('memory_above_threshold');
    });

    it('reports recent OOM before failover', () => {
      const result = evaluateHealthGate({
        memoryPct: 0.4,
        oomEventsRecent: 1,
        replicationLagBytes: 0,
        failoverInProgress: true,
      });
      expect(result.skipReason).toBe('recent_oom');
    });

    it('reports failover before replication lag', () => {
      const result = evaluateHealthGate({
        memoryPct: 0.4,
        oomEventsRecent: 0,
        replicationLagBytes: 100 * 1024 * 1024,
        failoverInProgress: true,
      });
      expect(result.skipReason).toBe('failover_in_progress');
    });
  });
});

describe('thresholdsFromEnv', () => {
  it('returns defaults when no env vars are set', () => {
    expect(thresholdsFromEnv({})).toEqual(DEFAULT_HEALTH_GATE_THRESHOLDS);
  });

  it('parses MONITOR_MEMORY_PCT_THRESHOLD as integer percent', () => {
    expect(thresholdsFromEnv({ MONITOR_MEMORY_PCT_THRESHOLD: '50' }).memoryPctThreshold).toBeCloseTo(0.5);
    expect(thresholdsFromEnv({ MONITOR_MEMORY_PCT_THRESHOLD: '10' }).memoryPctThreshold).toBeCloseTo(0.1);
    expect(thresholdsFromEnv({ MONITOR_MEMORY_PCT_THRESHOLD: '0' }).memoryPctThreshold).toBe(0);
  });

  it('falls back to default for invalid percent values', () => {
    for (const v of ['', 'abc', '-1', '101', '85.5']) {
      expect(thresholdsFromEnv({ MONITOR_MEMORY_PCT_THRESHOLD: v }).memoryPctThreshold).toBe(
        DEFAULT_HEALTH_GATE_THRESHOLDS.memoryPctThreshold,
      );
    }
  });

  it('parses MONITOR_REPLICATION_LAG_BYTES as positive integer', () => {
    expect(
      thresholdsFromEnv({ MONITOR_REPLICATION_LAG_BYTES: '5000' }).replicationLagThresholdBytes,
    ).toBe(5000);
  });

  it('falls back to default for invalid lag values', () => {
    for (const v of ['', 'nope', '-100']) {
      expect(thresholdsFromEnv({ MONITOR_REPLICATION_LAG_BYTES: v }).replicationLagThresholdBytes).toBe(
        DEFAULT_HEALTH_GATE_THRESHOLDS.replicationLagThresholdBytes,
      );
    }
  });
});
