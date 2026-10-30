import { IncidentTimelineEntry, matchSequence } from '../incident-timeline';
import { ReplicationStreamSample } from '../replication-stream';
import {
  BACKLOG_COVERAGE_CRITICAL_SEC,
  BACKLOG_COVERAGE_WARNING_SEC,
  RESYNC_ESCALATION_WINDOW_MS,
  backlogCoverageSec,
  createBacklogCoverageState,
  createResyncEscalationState,
  observeResyncEscalation,
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
    replBacklogHistlen: 1_000_000,
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
    expect(backlogCoverageSec(sample({ replBacklogHistlen: null }))).toBeNull();
  });

  it('carries no risk on an idle primary, a replica, or with no replicas', () => {
    expect(backlogCoverageSec(sample({ bytesPerSecEwma: 10 }))).toBe(Number.POSITIVE_INFINITY);
    expect(backlogCoverageSec(sample({ role: 'replica' }))).toBe(Number.POSITIVE_INFINITY);
    expect(backlogCoverageSec(sample({ replicas: [] }))).toBe(Number.POSITIVE_INFINITY);
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
    observeResyncEscalation(state, syncing, counters(1), 40);

    expect(observeResyncEscalation(state, back(T0 + 2000), counters(1), 40)).toHaveLength(1);
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
