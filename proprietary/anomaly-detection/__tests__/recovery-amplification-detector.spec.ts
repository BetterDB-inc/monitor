import { IncidentTimelineEntry, matchSequence, matchSequences } from '../incident-timeline';
import { ReplicationStreamSample } from '../replication-stream';
import {
  BACKLOG_COVERAGE_CRITICAL_SEC,
  BACKLOG_COVERAGE_WARNING_SEC,
  RESYNC_ESCALATION_WINDOW_MS,
  backlogCoverageSec,
  createBacklogCoverageState,
  createResyncEscalationState,
  observeResyncEscalation,
  resyncEventReplica,
  resyncSettled,
  stepBacklogCoverage,
} from '../recovery-amplification-detector';
import { getSequenceRules } from '../sequence-rules';
import { AnomalyPattern, AnomalySeverity, MetricType } from '../types';

const T0 = 1_700_000_000_000;

function sample(over: Partial<ReplicationStreamSample> = {}): ReplicationStreamSample {
  return {
    timestamp: T0,
    role: 'primary',
    replid: 'r',
    masterReplOffset: 1000,
    bytesPerSec: 10_000,
    bytesPerSecEwma: 10_000,
    replBacklogSize: 1_000_000,
    replicas: [
      { key: 'slave0', addr: '10.0.0.2:6379', state: 'online', offset: 1, lagSec: 0, gapBytes: 0 },
    ],
    ...over,
  };
}

const counters = (full = 0, partialOk = 0, partialErr = 0) => ({ full, partialOk, partialErr });

describe('backlogCoverageSec', () => {
  it('divides the backlog by the write rate', () => {
    expect(backlogCoverageSec(sample())).toBe(100);
  });

  it('uses the instantaneous rate when a burst outruns the smoothing', () => {
    expect(backlogCoverageSec(sample({ bytesPerSec: 100_000 }))).toBe(10);
  });

  it('uses the smoothed rate when the instantaneous rate dips', () => {
    expect(backlogCoverageSec(sample({ bytesPerSec: 100 }))).toBe(100);
  });

  it('holds when a rate or the backlog is unknown', () => {
    expect(backlogCoverageSec(sample({ bytesPerSec: null }))).toBeNull();
    expect(backlogCoverageSec(sample({ bytesPerSecEwma: null }))).toBeNull();
    expect(backlogCoverageSec(sample({ replBacklogSize: null }))).toBeNull();
  });

  it('holds on a primary with no replicas, so a disconnect cannot read as recovery', () => {
    expect(backlogCoverageSec(sample({ replicas: [] }))).toBeNull();
  });

  it('carries no risk on an idle primary or a replica', () => {
    expect(backlogCoverageSec(sample({ bytesPerSecEwma: 10 }))).toBe(Number.POSITIVE_INFINITY);
    expect(backlogCoverageSec(sample({ role: 'replica' }))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('stepBacklogCoverage', () => {
  const low = BACKLOG_COVERAGE_WARNING_SEC - 1;
  const veryLow = BACKLOG_COVERAGE_CRITICAL_SEC - 1;

  it('warns after three polls below the warning line', () => {
    const state = createBacklogCoverageState();
    expect(stepBacklogCoverage(state, low).escalatedTo).toBeNull();
    expect(stepBacklogCoverage(state, low).escalatedTo).toBeNull();
    expect(stepBacklogCoverage(state, low).escalatedTo).toBe('warning');
    expect(stepBacklogCoverage(state, low).escalatedTo).toBeNull();
  });

  it('restarts the count when coverage recovers between polls', () => {
    const state = createBacklogCoverageState();
    stepBacklogCoverage(state, low);
    stepBacklogCoverage(state, low);
    stepBacklogCoverage(state, BACKLOG_COVERAGE_WARNING_SEC + 1);
    expect(stepBacklogCoverage(state, low).escalatedTo).toBeNull();
  });

  it('escalates to critical once and does not step back down', () => {
    const state = createBacklogCoverageState();
    stepBacklogCoverage(state, veryLow);
    stepBacklogCoverage(state, veryLow);
    expect(stepBacklogCoverage(state, veryLow).escalatedTo).toBe('critical');
    expect(stepBacklogCoverage(state, low).escalatedTo).toBeNull();
    expect(state.level).toBe('critical');
  });

  it('clears only above the re-arm line', () => {
    const state = createBacklogCoverageState();
    for (let i = 0; i < 3; i += 1) stepBacklogCoverage(state, low);

    expect(stepBacklogCoverage(state, BACKLOG_COVERAGE_WARNING_SEC * 1.1).cleared).toBe(false);
    expect(stepBacklogCoverage(state, BACKLOG_COVERAGE_WARNING_SEC * 1.3).cleared).toBe(true);
    expect(state.level).toBe('none');
  });

  it('holds its state when coverage cannot be measured', () => {
    const state = createBacklogCoverageState();
    for (let i = 0; i < 3; i += 1) stepBacklogCoverage(state, low);

    expect(stepBacklogCoverage(state, null)).toEqual({ escalatedTo: null, cleared: false });
    expect(state.level).toBe('warning');
  });
});

describe('observeResyncEscalation', () => {
  const gone = (timestamp: number) => sample({ timestamp, replicas: [] });
  const back = (timestamp: number) => sample({ timestamp });

  it('emits one escalation when the replica returns through a full sync', () => {
    const state = createResyncEscalationState();
    observeResyncEscalation(state, back(T0), counters(1), 40);
    observeResyncEscalation(state, gone(T0 + 1000), counters(1), null);

    const [escalation, ...rest] = observeResyncEscalation(
      state,
      back(T0 + 31_000),
      counters(2),
      40,
    );

    expect(rest).toEqual([]);
    expect(escalation).toEqual({
      addr: '10.0.0.2:6379',
      disconnectedForMs: 30_000,
      coverageSec: 40,
      fullSyncs: 1,
      partialSyncErrors: 0,
      syncState: null,
    });
    expect(observeResyncEscalation(state, back(T0 + 32_000), counters(2), 40)).toEqual([]);
  });

  it('counts a sync that started on the poll that saw the disconnect', () => {
    const state = createResyncEscalationState();
    observeResyncEscalation(state, back(T0), counters(1), 40);
    observeResyncEscalation(state, gone(T0 + 1000), counters(2), null);

    expect(observeResyncEscalation(state, back(T0 + 2000), counters(2), 40)).toHaveLength(1);
  });

  it('escalates on a failed partial sync', () => {
    const state = createResyncEscalationState();
    observeResyncEscalation(state, back(T0), counters(), 40);
    observeResyncEscalation(state, gone(T0 + 1000), counters(), null);

    const [escalation] = observeResyncEscalation(state, back(T0 + 2000), counters(0, 0, 1), 40);

    expect(escalation.partialSyncErrors).toBe(1);
  });

  it('stays quiet when the backlog covered the disconnect', () => {
    const state = createResyncEscalationState();
    observeResyncEscalation(state, back(T0), counters(), 40);
    observeResyncEscalation(state, gone(T0 + 1000), counters(), null);

    expect(observeResyncEscalation(state, back(T0 + 2000), counters(0, 1), 40)).toEqual([]);
  });

  it('treats a replica leaving the online state as a disconnect', () => {
    const state = createResyncEscalationState();
    observeResyncEscalation(state, back(T0), counters(), 40);
    const syncing = sample({
      timestamp: T0 + 1000,
      replicas: [{ ...sample().replicas[0], state: 'send_bulk' }],
    });

    expect(observeResyncEscalation(state, syncing, counters(1), 40)).toHaveLength(1);
    expect(observeResyncEscalation(state, back(T0 + 2000), counters(1), 40)).toEqual([]);
  });

  describe('while the replica is syncing', () => {
    const REPLICA_A = '10.0.0.2:6379';
    const REPLICA_B = '10.0.0.3:6379';
    const line = (addr: string, state: string) => ({
      ...sample().replicas[0],
      addr,
      state,
    });
    const at = (timestamp: number, ...replicas: ReplicationStreamSample['replicas']) =>
      sample({ timestamp, replicas });

    it.each(['wait_bgsave', 'send_bulk'])('emits when the replica enters %s', (syncState) => {
      const state = createResyncEscalationState();
      observeResyncEscalation(state, back(T0), counters(), 40);
      observeResyncEscalation(state, gone(T0 + 1000), counters(), null);

      const [escalation] = observeResyncEscalation(
        state,
        at(T0 + 3000, line(REPLICA_A, syncState)),
        counters(),
        null,
      );

      expect(escalation).toMatchObject({
        addr: REPLICA_A,
        syncState,
        disconnectedForMs: 2000,
        coverageSec: 40,
      });
    });

    it('reports a resync that outlasts the escalation window', () => {
      const state = createResyncEscalationState();
      observeResyncEscalation(state, back(T0), counters(), 40);
      observeResyncEscalation(state, gone(T0 + 1000), counters(), null);
      const syncing = at(T0 + 2000, line(REPLICA_A, 'send_bulk'));

      expect(observeResyncEscalation(state, syncing, counters(1), null)).toHaveLength(1);

      const late = at(T0 + 2 * RESYNC_ESCALATION_WINDOW_MS, line(REPLICA_A, 'send_bulk'));
      expect(observeResyncEscalation(state, late, counters(1), null)).toEqual([]);
    });

    it('precedes the cost of serving the resync', () => {
      const state = createResyncEscalationState();
      observeResyncEscalation(state, back(T0), counters(), 40);
      const syncing = at(T0 + 1000, line(REPLICA_A, 'wait_bgsave'));
      const [{ addr }] = observeResyncEscalation(state, syncing, counters(1), null);
      const rule = getSequenceRules().find(
        (r) => r.pattern === AnomalyPattern.RECOVERY_AMPLIFICATION,
      )!;
      const entries: IncidentTimelineEntry[] = [
        [MetricType.RESYNC_ESCALATION, syncing.timestamp],
        [MetricType.FORK_MEMORY_RISK, syncing.timestamp],
      ].map(([metricType, timestamp]) => ({
        anomalyId: `${metricType}`,
        connectionId: addr,
        timestamp: timestamp as number,
        metricType: metricType as MetricType,
        severity: AnomalySeverity.WARNING,
        message: '',
        recoveredAt: null,
      }));

      expect(matchSequence(entries, rule)).toHaveLength(2);
    });

    it('does not blame a partial resume on the full sync of another replica', () => {
      const state = createResyncEscalationState();
      const online = at(T0, line(REPLICA_A, 'online'), line(REPLICA_B, 'online'));
      observeResyncEscalation(state, online, counters(), 40);
      observeResyncEscalation(state, at(T0 + 1000), counters(), null);

      const b = observeResyncEscalation(
        state,
        at(T0 + 2000, line(REPLICA_B, 'wait_bgsave')),
        counters(1, 0, 1),
        null,
      );
      const a = observeResyncEscalation(
        state,
        at(T0 + 3000, line(REPLICA_A, 'online'), line(REPLICA_B, 'send_bulk')),
        counters(1, 1, 1),
        null,
      );

      expect(b.map((e) => e.addr)).toEqual([REPLICA_B]);
      expect(a).toEqual([]);
    });

    it('still blames a replica whose own failure moved the counters past that', () => {
      const state = createResyncEscalationState();
      const online = at(T0, line(REPLICA_A, 'online'), line(REPLICA_B, 'online'));
      observeResyncEscalation(state, online, counters(), 40);
      observeResyncEscalation(state, at(T0 + 1000), counters(), null);
      observeResyncEscalation(
        state,
        at(T0 + 2000, line(REPLICA_B, 'wait_bgsave')),
        counters(1),
        null,
      );

      const a = observeResyncEscalation(
        state,
        at(T0 + 3000, line(REPLICA_A, 'online'), line(REPLICA_B, 'send_bulk')),
        counters(2),
        null,
      );

      expect(a).toMatchObject([{ addr: REPLICA_A, fullSyncs: 1 }]);
    });
  });

  describe('resyncSettled', () => {
    const line = (state: string) => ({ ...sample().replicas[0], state });

    it('waits for the replica to reach online', () => {
      expect(
        resyncSettled(sample({ replicas: [line('send_bulk')] }), '10.0.0.2:6379', T0 - 1),
      ).toBe(false);
      expect(resyncSettled(sample({ replicas: [line('online')] }), '10.0.0.2:6379', T0 - 1)).toBe(
        true,
      );
    });

    it('settles a replica that never came back once the window has passed', () => {
      expect(resyncSettled(sample({ replicas: [] }), '10.0.0.2:6379', T0 - 1)).toBe(false);
      expect(
        resyncSettled(
          sample({ replicas: [] }),
          '10.0.0.2:6379',
          T0 - RESYNC_ESCALATION_WINDOW_MS - 1,
        ),
      ).toBe(true);
    });

    it('settles when the node is no longer a primary', () => {
      expect(
        resyncSettled(sample({ role: 'replica', replicas: [] }), '10.0.0.2:6379', T0 - 1),
      ).toBe(true);
    });
  });

  it('forgets a disconnect that outlasts the escalation window', () => {
    const state = createResyncEscalationState();
    observeResyncEscalation(state, back(T0), counters(), 40);
    observeResyncEscalation(state, gone(T0 + 1000), counters(), null);

    const late = T0 + 1000 + RESYNC_ESCALATION_WINDOW_MS + 1;
    observeResyncEscalation(state, gone(late), counters(1), null);

    expect(observeResyncEscalation(state, back(late + 1000), counters(1), 40)).toEqual([]);
  });

  it('ignores a counter reset from a restart', () => {
    const state = createResyncEscalationState();
    observeResyncEscalation(state, back(T0), counters(9), 40);
    observeResyncEscalation(state, gone(T0 + 1000), counters(0), null);

    expect(observeResyncEscalation(state, back(T0 + 2000), counters(0), 40)).toEqual([]);
  });
});

describe('recovery amplification rule', () => {
  it('registers a resync followed by a recovery cost', () => {
    const rule = getSequenceRules().find(
      (r) => r.pattern === AnomalyPattern.RECOVERY_AMPLIFICATION,
    );

    expect(rule?.steps[0]).toEqual([MetricType.RESYNC_ESCALATION]);
    expect(rule?.steps[1]).toContain(MetricType.FORK_MEMORY_RISK);
    expect(rule?.maxSpanMs).toBe(10 * 60_000);
  });

  const entry = (metricType: MetricType, timestamp: number): IncidentTimelineEntry => ({
    anomalyId: `${metricType}-${timestamp}`,
    connectionId: 'c',
    timestamp,
    metricType,
    severity: AnomalySeverity.WARNING,
    message: '',
    recoveredAt: null,
  });
  const rule = () =>
    getSequenceRules().find((r) => r.pattern === AnomalyPattern.RECOVERY_AMPLIFICATION)!;

  it('matches a resync followed by fork memory risk', () => {
    const entries = [
      entry(MetricType.RESYNC_ESCALATION, T0),
      entry(MetricType.FORK_MEMORY_RISK, T0 + 60_000),
    ];

    expect(matchSequence(entries, rule())).toHaveLength(2);
  });

  it('records every repeat of the pattern in one incident', () => {
    const entries = [
      entry(MetricType.RESYNC_ESCALATION, T0),
      entry(MetricType.FORK_MEMORY_RISK, T0 + 60_000),
      entry(MetricType.RESYNC_ESCALATION, T0 + 120_000),
      entry(MetricType.FORK_MEMORY_RISK, T0 + 180_000),
    ];

    expect(matchSequences(entries, rule()).map((m) => m.map((e) => e.timestamp))).toEqual([
      [T0, T0 + 60_000],
      [T0 + 120_000, T0 + 180_000],
    ]);
  });

  it('ignores a cost on another connection', () => {
    const entries = [
      entry(MetricType.RESYNC_ESCALATION, T0),
      { ...entry(MetricType.FORK_MEMORY_RISK, T0 + 60_000), connectionId: 'other-shard' },
    ];

    expect(matchSequence(entries, rule())).toBeNull();
  });

  it('reads the replica back from a stored message', () => {
    expect(resyncEventReplica('Replica 10.0.0.2:6379 came back after 5s')).toBe('10.0.0.2:6379');
    expect(resyncEventReplica('nothing useful')).toBeNull();
  });

  it('ignores a cost that came before the resync or outside the span', () => {
    expect(
      matchSequence(
        [entry(MetricType.FORK_MEMORY_RISK, T0), entry(MetricType.RESYNC_ESCALATION, T0 + 1)],
        rule(),
      ),
    ).toBeNull();
    expect(
      matchSequence(
        [
          entry(MetricType.RESYNC_ESCALATION, T0),
          entry(MetricType.FORK_MEMORY_RISK, T0 + 10 * 60_000 + 1),
        ],
        rule(),
      ),
    ).toBeNull();
  });
});
