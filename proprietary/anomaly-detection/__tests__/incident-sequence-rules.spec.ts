import { IncidentTimelineBuilder, RecoveryProbe } from '../incident-timeline';
import {
  BACKLOG_EXHAUSTION_MAX_SPAN_MS,
  DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS,
  HOT_SHARD_LATENCY_LEAD_MS,
  HOT_SHARD_LATENCY_MAX_SPAN_MS,
  MEMBERSHIP_FAILOVER_MAX_SPAN_MS,
  MIGRATION_REDIRECTS_MAX_SPAN_MS,
  RESHARD_DIVERGENCE_PRESSURE_MAX_SPAN_MS,
  RESHARD_UNDER_WRITES_MAX_SPAN_MS,
  RETRY_STORM_MAX_SPAN_MS,
  SPLIT_BRAIN_MAX_SPAN_MS,
} from '../incident-sequence-rules';
import { RESYNC_ESCALATION_WINDOW_MS } from '../recovery-amplification-detector';
import { SequenceRule, getSequenceRules } from '../sequence-rules';
import { AnomalyEvent, AnomalyPattern, AnomalySeverity, AnomalyType, MetricType } from '../types';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const neverRecovers: RecoveryProbe = () => null;

let seq = 0;
function event(
  metricType: MetricType,
  at: number,
  connectionId = 'conn-a',
  anomalyType = AnomalyType.SPIKE,
): AnomalyEvent {
  seq++;
  return {
    id: `evt-${String(seq).padStart(3, '0')}`,
    timestamp: T0 + at,
    metricType,
    anomalyType,
    // A duplicate primary is critical; split_brain takes no cluster_topology event below that.
    severity:
      metricType === MetricType.CLUSTER_TOPOLOGY
        ? AnomalySeverity.CRITICAL
        : AnomalySeverity.WARNING,
    value: 1,
    baseline: 0,
    stdDev: 0,
    zScore: 4,
    threshold: 3,
    message: 'msg',
    resolved: false,
    connectionId,
  };
}

function ruleFor(pattern: AnomalyPattern): SequenceRule {
  const rule = getSequenceRules().find((r) => r.pattern === pattern);
  if (!rule) throw new Error(`${pattern} is not registered`);
  return rule;
}

function incidentsOf(events: AnomalyEvent[], rules: readonly SequenceRule[], scope = (id: string) => id) {
  return new IncidentTimelineBuilder({}, scope, () => rules).build(events, T0 + 60 * MIN, neverRecovers);
}

function patternsOf(events: AnomalyEvent[], pattern: AnomalyPattern, scope = (id: string) => id) {
  return incidentsOf(events, [ruleFor(pattern)], scope).flatMap((incident) => incident.matchedPatterns);
}

const drop = (metric: MetricType, at: number, connectionId = 'conn-a') =>
  event(metric, at, connectionId, AnomalyType.DROP);

interface RuleCase {
  pattern: AnomalyPattern;
  steps: MetricType[];
  alternatives: MetricType[][];
  optional?: MetricType;
  spanMs: number;
  lead?: { step: number; ms: number };
  sameConnection: boolean;
  rising: MetricType[];
}

const WRITE_AND_MEMORY_RISES = [
  MetricType.OPS_PER_SEC,
  MetricType.INPUT_KBPS,
  MetricType.MEMORY_USED,
  MetricType.EVICTED_KEYS,
  MetricType.EVICTED_CLIENTS,
];

const cases: RuleCase[] = [
  {
    pattern: AnomalyPattern.DIVERGENCE_UNDER_PRESSURE,
    steps: [MetricType.INPUT_KBPS, MetricType.REPLICATION_DIVERGENCE, MetricType.REPL_BUFFER_PRESSURE],
    alternatives: [
      [MetricType.OPS_PER_SEC, MetricType.INPUT_KBPS],
      [MetricType.REPLICATION_DIVERGENCE],
      [MetricType.MEMORY_USED, MetricType.MEMORY_OVERHEAD, MetricType.REPL_BUFFER_PRESSURE],
    ],
    optional: MetricType.EVICTED_KEYS,
    spanMs: DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS,
    lead: { step: 2, ms: DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS },
    sameConnection: true,
    rising: WRITE_AND_MEMORY_RISES,
  },
  {
    pattern: AnomalyPattern.RESHARD_UNDER_WRITES,
    steps: [MetricType.RESHARD_SHARD_SKEW, MetricType.REPLICATION_DIVERGENCE],
    alternatives: [[MetricType.RESHARD_SHARD_SKEW], [MetricType.REPLICATION_DIVERGENCE]],
    optional: MetricType.COMMAND_P99,
    spanMs: RESHARD_UNDER_WRITES_MAX_SPAN_MS,
    sameConnection: false,
    rising: [],
  },
  {
    pattern: AnomalyPattern.RESHARD_DIVERGENCE_PRESSURE,
    steps: [MetricType.RESHARD_SHARD_SKEW, MetricType.REPLICATION_DIVERGENCE, MetricType.REPL_BUFFER_PRESSURE],
    alternatives: [
      [MetricType.RESHARD_SHARD_SKEW],
      [MetricType.REPLICATION_DIVERGENCE],
      [MetricType.MEMORY_USED, MetricType.MEMORY_OVERHEAD, MetricType.REPL_BUFFER_PRESSURE],
    ],
    optional: MetricType.INPUT_KBPS,
    spanMs: RESHARD_DIVERGENCE_PRESSURE_MAX_SPAN_MS,
    lead: { step: 2, ms: RESHARD_DIVERGENCE_PRESSURE_MAX_SPAN_MS },
    sameConnection: true,
    rising: WRITE_AND_MEMORY_RISES,
  },
  {
    pattern: AnomalyPattern.RETRY_STORM,
    steps: [MetricType.ERROR_REPLIES, MetricType.RETRY_AMPLIFICATION],
    alternatives: [
      [MetricType.COMMAND_P99, MetricType.ERROR_REPLIES, MetricType.CONNECTION_CHURN],
      [MetricType.RETRY_AMPLIFICATION],
    ],
    optional: MetricType.CLIENT_LOCKOUT_RISK,
    spanMs: RETRY_STORM_MAX_SPAN_MS,
    sameConnection: true,
    rising: [MetricType.COMMAND_P99, MetricType.ERROR_REPLIES, MetricType.CONNECTION_CHURN],
  },
  {
    pattern: AnomalyPattern.BACKLOG_EXHAUSTION,
    steps: [MetricType.BACKLOG_COVERAGE_RISK, MetricType.RESYNC_ESCALATION],
    alternatives: [[MetricType.BACKLOG_COVERAGE_RISK], [MetricType.RESYNC_ESCALATION]],
    spanMs: BACKLOG_EXHAUSTION_MAX_SPAN_MS,
    lead: { step: 1, ms: RESYNC_ESCALATION_WINDOW_MS },
    sameConnection: true,
    rising: [],
  },
  {
    pattern: AnomalyPattern.SPLIT_BRAIN,
    steps: [MetricType.TOPOLOGY_DIVERGENCE, MetricType.CLUSTER_TOPOLOGY],
    alternatives: [
      [MetricType.TOPOLOGY_DIVERGENCE, MetricType.PARTIAL_MEMBERSHIP],
      [MetricType.CLUSTER_TOPOLOGY, MetricType.REPLICATION_ROLE],
    ],
    optional: MetricType.FAILOVER_CHURN,
    spanMs: SPLIT_BRAIN_MAX_SPAN_MS,
    sameConnection: true,
    rising: [MetricType.ERROR_REPLIES],
  },
  {
    pattern: AnomalyPattern.HOT_SHARD_LATENCY,
    steps: [MetricType.HOT_SHARD, MetricType.COMMAND_P99],
    alternatives: [[MetricType.HOT_SHARD], [MetricType.COMMAND_P99, MetricType.RETRY_AMPLIFICATION]],
    optional: MetricType.CLIENT_SATURATION,
    spanMs: HOT_SHARD_LATENCY_MAX_SPAN_MS,
    lead: { step: 1, ms: HOT_SHARD_LATENCY_LEAD_MS },
    sameConnection: true,
    rising: [MetricType.COMMAND_P99, MetricType.ERROR_REPLIES],
  },
  {
    pattern: AnomalyPattern.MIGRATION_REDIRECTS,
    steps: [MetricType.SLOT_MIGRATION, MetricType.ERROR_REPLIES],
    alternatives: [
      [MetricType.SLOT_MIGRATION, MetricType.SLOT_MIGRATION_STUCK],
      [MetricType.ERROR_REPLIES, MetricType.COMMAND_P99],
    ],
    optional: MetricType.RETRY_AMPLIFICATION,
    spanMs: MIGRATION_REDIRECTS_MAX_SPAN_MS,
    sameConnection: true,
    rising: [MetricType.ERROR_REPLIES, MetricType.COMMAND_P99],
  },
  {
    pattern: AnomalyPattern.MEMBERSHIP_FAILOVER,
    steps: [MetricType.PARTIAL_MEMBERSHIP, MetricType.FAILOVER_CHURN],
    alternatives: [
      [MetricType.PARTIAL_MEMBERSHIP, MetricType.GHOST_MEMBERSHIP],
      [MetricType.FAILOVER_CHURN],
    ],
    optional: MetricType.TOPOLOGY_DIVERGENCE,
    spanMs: MEMBERSHIP_FAILOVER_MAX_SPAN_MS,
    sameConnection: true,
    rising: [],
  },
];

describe('incident sequence rules', () => {
  beforeEach(() => {
    seq = 0;
  });

  it.each(cases)('$pattern has a diagnosis and recommendations', ({ pattern }) => {
    const rule = ruleFor(pattern);

    expect(rule.diagnosis.length).toBeGreaterThan(0);
    expect(rule.recommendations.length).toBeGreaterThan(0);
  });

  describe.each(cases)(
    '$pattern',
    ({ pattern, steps, alternatives, optional, spanMs, lead, sameConnection, rising }) => {
    const inOrder = (gapMs = MIN) => steps.map((metric, i) => event(metric, i * gapMs));

    it('matches its steps in order', () => {
      expect(patternsOf(inOrder(), pattern)).toEqual([pattern]);
    });

    it('has the expected alternatives in every step', () => {
      expect(ruleFor(pattern).steps).toEqual(alternatives);
    });

    it.each(
      alternatives.flatMap((metrics, stepIndex) => metrics.map((metric) => ({ stepIndex, metric }))),
    )('matches with $metric as step $stepIndex', ({ stepIndex, metric }) => {
      const events = steps.map((step, i) => event(i === stepIndex ? metric : step, i * MIN));

      expect(patternsOf(events, pattern)).toEqual([pattern]);
    });

    it('matches across quiet gaps that stay within its span', () => {
      const gapMs = Math.floor(spanMs / steps.length);

      expect(patternsOf(inOrder(gapMs), pattern)).toEqual([pattern]);
    });

    it('does not match its steps in reverse', () => {
      const gapMs = (lead?.ms ?? 0) + MIN;
      const reversed = [...steps].reverse().map((metric, i) => event(metric, i * gapMs));

      expect(patternsOf(reversed, pattern)).toEqual([]);
    });

    it('does not match past its span', () => {
      const late = steps.map((metric, i) =>
        event(metric, i === steps.length - 1 ? spanMs + MIN : i * MIN),
      );

      expect(patternsOf(late, pattern)).toEqual([]);
    });

    it('does not match without its first step', () => {
      const missing = steps.slice(1).map((metric, i) => event(metric, i * MIN));

      expect(patternsOf(missing, pattern)).toEqual([]);
    });

    if (lead) {
      const withLeadStepAt = (leadAt: (previousAt: number, lastOtherAt: number) => number) => {
        const others = steps.filter((_, i) => i !== lead.step);
        const lastOtherAt = (others.length - 1) * MIN;
        const previousAt = (lead.step - 1) * MIN;
        return steps.map((metric, i) =>
          event(metric, i === lead.step ? leadAt(previousAt, lastOtherAt) : (i < lead.step ? i : i - 1) * MIN),
        );
      };

      it('matches its lead step before the step it follows, within the lead', () => {
        const events = withLeadStepAt(
          (previousAt, lastOtherAt) => previousAt - Math.min(lead.ms, spanMs - lastOtherAt),
        );

        expect(patternsOf(events, pattern)).toEqual([pattern]);
      });

      it('does not match its lead step further back than the lead', () => {
        const events = withLeadStepAt((previousAt) => previousAt - lead.ms - MIN);

        expect(patternsOf(events, pattern)).toEqual([]);
      });
    }

    it('requires a rise on exactly the expected metrics', () => {
      const directions = ruleFor(pattern).directions ?? {};

      expect(Object.keys(directions).sort()).toEqual([...rising].sort());
      expect(Object.values(directions).every((d) => d === 'rise')).toBe(true);
    });

    const directed = alternatives.flatMap((metrics, stepIndex) =>
      metrics.filter((metric) => rising.includes(metric)).map((metric) => ({ stepIndex, metric })),
    );
    if (directed.length > 0) {
      it.each(directed)('does not take a drop in $metric as step $stepIndex', ({ stepIndex, metric }) => {
        const events = steps.map((step, i) =>
          i === stepIndex ? drop(metric, i * MIN) : event(step, i * MIN),
        );

        expect(patternsOf(events, pattern)).toEqual([]);
      });
    }

    const directedOptional = rising.filter((metric) => !alternatives.flat().includes(metric));
    if (directedOptional.length > 0) {
      it.each(directedOptional)('does not take in a drop in optional %s', (metric) => {
        const events = [...inOrder(), drop(metric, steps.length * MIN)];
        const [incident] = incidentsOf(events, [ruleFor(pattern)]);

        expect(incident.sequenceMatches[0].anomalyIds).toHaveLength(steps.length);
      });
    }

    if (optional) {
      it('takes in its optional signal', () => {
        const events = [...inOrder(), event(optional, steps.length * MIN)];
        const [incident] = new IncidentTimelineBuilder({}, (id) => id, () => [ruleFor(pattern)]).build(
          events,
          T0 + 60 * MIN,
          neverRecovers,
        );

        expect(incident.sequenceMatches[0].anomalyIds).toHaveLength(steps.length + 1);
      });
    }

    it(
      sameConnection
        ? 'does not chain steps from different connections'
        : 'chains steps from different nodes of the cluster',
      () => {
        const spread = steps.map((metric, i) => event(metric, i * MIN, `conn-${i}`));

        expect(patternsOf(spread, pattern, () => 'cluster')).toEqual(sameConnection ? [] : [pattern]);
      },
    );
  },
  );

  describe('overlapping reshard, divergence and memory pressure', () => {
    const allRules = () => getSequenceRules();
    const compound = AnomalyPattern.RESHARD_DIVERGENCE_PRESSURE;

    it('yields one compound match instead of reshard_under_writes and divergence_under_pressure', () => {
      const events = [
        event(MetricType.RESHARD_SHARD_SKEW, 0),
        event(MetricType.OPS_PER_SEC, MIN),
        event(MetricType.REPLICATION_DIVERGENCE, 2 * MIN),
        event(MetricType.REPL_BUFFER_PRESSURE, 3 * MIN),
      ];
      const [incident] = incidentsOf(events, allRules());

      expect(incident.matchedPatterns).toEqual([compound]);
      expect(incident.sequenceMatches[0].diagnosis).toBe(ruleFor(compound).diagnosis);
      expect(incident.sequenceMatches[0].anomalyIds).toEqual(
        expect.arrayContaining(events.map((e) => e.id)),
      );
    });

    it('does not combine a reshard skew on one primary with divergence on another', () => {
      const events = [
        event(MetricType.RESHARD_SHARD_SKEW, 0, 'conn-b'),
        event(MetricType.REPLICATION_DIVERGENCE, MIN, 'conn-a'),
        event(MetricType.REPL_BUFFER_PRESSURE, 2 * MIN, 'conn-a'),
      ];

      expect(incidentsOf(events, allRules(), () => 'cluster')[0].matchedPatterns).toEqual([
        AnomalyPattern.RESHARD_UNDER_WRITES,
      ]);
    });

    it('does not combine divergence and pressure from different primaries', () => {
      const events = [
        event(MetricType.RESHARD_SHARD_SKEW, 0, 'conn-a'),
        event(MetricType.REPLICATION_DIVERGENCE, MIN, 'conn-a'),
        event(MetricType.REPL_BUFFER_PRESSURE, 2 * MIN, 'conn-b'),
      ];

      expect(incidentsOf(events, allRules(), () => 'cluster')[0].matchedPatterns).toEqual([
        AnomalyPattern.RESHARD_UNDER_WRITES,
      ]);
    });

    it('leaves divergence_under_pressure alone without a reshard', () => {
      const events = [
        event(MetricType.OPS_PER_SEC, 0),
        event(MetricType.REPLICATION_DIVERGENCE, MIN),
        event(MetricType.REPL_BUFFER_PRESSURE, 2 * MIN),
      ];

      expect(incidentsOf(events, allRules())[0].matchedPatterns).toEqual([
        AnomalyPattern.DIVERGENCE_UNDER_PRESSURE,
      ]);
    });

    it('leaves reshard_under_writes alone without memory or buffer pressure', () => {
      const events = [event(MetricType.RESHARD_SHARD_SKEW, 0), event(MetricType.REPLICATION_DIVERGENCE, MIN)];

      expect(incidentsOf(events, allRules())[0].matchedPatterns).toEqual([
        AnomalyPattern.RESHARD_UNDER_WRITES,
      ]);
    });

    it('does not take a drop in memory as the pressure step', () => {
      const events = [
        event(MetricType.RESHARD_SHARD_SKEW, 0),
        event(MetricType.REPLICATION_DIVERGENCE, MIN),
        drop(MetricType.MEMORY_USED, 2 * MIN),
      ];

      expect(incidentsOf(events, allRules())[0].matchedPatterns).toEqual([
        AnomalyPattern.RESHARD_UNDER_WRITES,
      ]);
    });

    it('keeps a superseded rule whose match shares no event with the compound match', () => {
      const first: SequenceRule = {
        pattern: AnomalyPattern.BATCH_JOB,
        steps: [[MetricType.OPS_PER_SEC], [MetricType.MEMORY_USED]],
        maxSpanMs: 15 * MIN,
        diagnosis: 'batch',
        recommendations: [],
      };
      const combined: SequenceRule = {
        pattern: AnomalyPattern.TRAFFIC_BURST,
        steps: [[MetricType.RESHARD_SHARD_SKEW], [MetricType.REPLICATION_DIVERGENCE]],
        maxSpanMs: 15 * MIN,
        supersedes: [AnomalyPattern.BATCH_JOB],
        diagnosis: 'combined',
        recommendations: [],
      };
      const events = [
        event(MetricType.OPS_PER_SEC, 0),
        event(MetricType.MEMORY_USED, MIN),
        event(MetricType.RESHARD_SHARD_SKEW, 2 * MIN),
        event(MetricType.REPLICATION_DIVERGENCE, 3 * MIN),
      ];

      expect(incidentsOf(events, [first, combined])[0].matchedPatterns).toEqual([
        AnomalyPattern.BATCH_JOB,
        AnomalyPattern.TRAFFIC_BURST,
      ]);
    });
  });

  describe('overlapping split brain and membership failover', () => {
    const splitBrain = AnomalyPattern.SPLIT_BRAIN;
    const membership = AnomalyPattern.MEMBERSHIP_FAILOVER;

    it('lists only split_brain when the failovers lead on to two primaries', () => {
      const events = [
        event(MetricType.PARTIAL_MEMBERSHIP, 0),
        event(MetricType.FAILOVER_CHURN, MIN),
        event(MetricType.CLUSTER_TOPOLOGY, 5 * MIN),
      ];
      const incidents = incidentsOf(events, getSequenceRules());

      expect(incidents.flatMap((i) => i.matchedPatterns)).toEqual([splitBrain]);
      expect(incidents[0].sequenceMatches[0].anomalyIds).toEqual(
        expect.arrayContaining(events.map((e) => e.id)),
      );
    });

    it('keeps membership_failover when split_brain shares none of its steps', () => {
      const events = [
        event(MetricType.GHOST_MEMBERSHIP, 0),
        event(MetricType.FAILOVER_CHURN, MIN),
        event(MetricType.TOPOLOGY_DIVERGENCE, 2 * MIN),
        event(MetricType.CLUSTER_TOPOLOGY, 3 * MIN),
      ];
      const [incident] = incidentsOf(events, getSequenceRules());

      expect(incident.matchedPatterns.slice().sort()).toEqual([membership, splitBrain].sort());
    });
  });

  describe('split_brain and the severity of cluster_topology', () => {
    const splitBrain = AnomalyPattern.SPLIT_BRAIN;
    const topology = (at: number, severity: AnomalySeverity) => ({
      ...event(MetricType.CLUSTER_TOPOLOGY, at),
      severity,
    });

    it.each([MetricType.PARTIAL_MEMBERSHIP, MetricType.TOPOLOGY_DIVERGENCE])(
      'does not match %s followed by a stuck replica warning',
      (first) => {
        const events = [event(first, 0), topology(MIN, AnomalySeverity.WARNING)];

        expect(patternsOf(events, splitBrain)).toEqual([]);
      },
    );

    it.each([MetricType.PARTIAL_MEMBERSHIP, MetricType.TOPOLOGY_DIVERGENCE])(
      'matches %s followed by a duplicate primary',
      (first) => {
        const events = [event(first, 0), topology(MIN, AnomalySeverity.CRITICAL)];

        expect(patternsOf(events, splitBrain)).toEqual([splitBrain]);
      },
    );

    it('takes the duplicate primary as its step when a stuck replica came first', () => {
      const events = [
        event(MetricType.PARTIAL_MEMBERSHIP, 0),
        topology(MIN, AnomalySeverity.WARNING),
        topology(MIN, AnomalySeverity.CRITICAL),
      ];
      const [incident] = incidentsOf(events, [ruleFor(splitBrain)]);

      expect(incident.sequenceMatches[0].anomalyIds).toEqual([events[0].id, events[2].id]);
    });

    it('does not keep a stuck replica after a quiet gap in the same incident', () => {
      const events = [
        event(MetricType.PARTIAL_MEMBERSHIP, 0),
        topology(5 * MIN, AnomalySeverity.WARNING),
      ];

      expect(incidentsOf(events, [ruleFor(splitBrain)])).toHaveLength(2);
    });

    it('leaves membership_failover listed beside a stuck replica', () => {
      const events = [
        event(MetricType.PARTIAL_MEMBERSHIP, 0),
        event(MetricType.FAILOVER_CHURN, MIN),
        topology(2 * MIN, AnomalySeverity.WARNING),
      ];
      const [incident] = incidentsOf(events, getSequenceRules());

      expect(incident.matchedPatterns).toEqual([AnomalyPattern.MEMBERSHIP_FAILOVER]);
    });
  });

  it('takes a slot migration that is stuck as the first step of migration_redirects', () => {
    const events = [
      event(MetricType.SLOT_MIGRATION_STUCK, 0),
      event(MetricType.ERROR_REPLIES, 5 * MIN),
    ];

    expect(patternsOf(events, AnomalyPattern.MIGRATION_REDIRECTS)).toEqual([
      AnomalyPattern.MIGRATION_REDIRECTS,
    ]);
  });

  it('matches a P99 rise raised 8 minutes before the hot shard', () => {
    const events = [event(MetricType.COMMAND_P99, 0), event(MetricType.HOT_SHARD, 8 * MIN)];

    expect(patternsOf(events, AnomalyPattern.HOT_SHARD_LATENCY)).toEqual([
      AnomalyPattern.HOT_SHARD_LATENCY,
    ]);
  });

  describe('retry_storm', () => {
    const retryStorm = AnomalyPattern.RETRY_STORM;

    it('matches a churn-triggered retry loop without saturation', () => {
      const churn = event(MetricType.CONNECTION_CHURN, 0);
      const retries = { ...event(MetricType.RETRY_AMPLIFICATION, 2 * MIN), retryTrigger: 'churn' as const };

      expect(patternsOf([churn, retries], retryStorm)).toEqual([retryStorm]);
    });

    it('matches a churn-triggered retry amplification without a separate churn event', () => {
      const retries = { ...event(MetricType.RETRY_AMPLIFICATION, 0), retryTrigger: 'churn' as const };
      const saturation = event(MetricType.CLIENT_SATURATION, MIN);
      const [incident] = incidentsOf([retries, saturation], [ruleFor(retryStorm)]);

      expect(incident.matchedPatterns).toEqual([retryStorm]);
      expect(incident.sequenceMatches[0].steps).toEqual([
        { anomalyId: retries.id, step: 2 },
        { anomalyId: saturation.id, step: null },
      ]);
    });

    it.each(['latency', 'errors'] as const)(
      'does not match a %s-triggered retry amplification without its trigger event',
      (retryTrigger) => {
        const retries = { ...event(MetricType.RETRY_AMPLIFICATION, 0), retryTrigger };

        expect(patternsOf([retries], retryStorm)).toEqual([]);
      },
    );

    it('keeps saturation that follows the retry amplification after a quiet gap in the storm', () => {
      const saturation = event(MetricType.REJECTED_CONNECTIONS, 4 * MIN);
      const incidents = incidentsOf(
        [event(MetricType.COMMAND_P99, 0), event(MetricType.RETRY_AMPLIFICATION, MIN), saturation],
        [ruleFor(retryStorm)],
      );

      expect(incidents).toHaveLength(1);
      expect(incidents[0].sequenceMatches[0].anomalyIds).toContain(saturation.id);
    });

    it('keeps saturation after a quiet gap in a churn-triggered storm', () => {
      const retries = { ...event(MetricType.RETRY_AMPLIFICATION, 0), retryTrigger: 'churn' as const };

      expect(incidentsOf([retries, event(MetricType.CLIENT_SATURATION, 4 * MIN)], [ruleFor(retryStorm)])).toHaveLength(1);
    });

    it('does not match a churn drop followed by retry amplification', () => {
      const events = [drop(MetricType.CONNECTION_CHURN, 0), event(MetricType.RETRY_AMPLIFICATION, 2 * MIN)];

      expect(patternsOf(events, retryStorm)).toEqual([]);
    });

    it('does not match retry amplification alone', () => {
      expect(patternsOf([event(MetricType.RETRY_AMPLIFICATION, 0)], retryStorm)).toEqual([]);
    });

    it('takes in saturation raised before the retry amplification', () => {
      const events = [
        event(MetricType.CLIENT_SATURATION, 0),
        event(MetricType.COMMAND_P99, MIN),
        event(MetricType.RETRY_AMPLIFICATION, 2 * MIN),
      ];
      const [incident] = incidentsOf(events, [ruleFor(retryStorm)]);

      expect(incident.sequenceMatches[0].anomalyIds).toEqual(
        expect.arrayContaining(events.map((e) => e.id)),
      );
    });
  });

  it('does not take a drop in ops/sec as the write rise of divergence_under_pressure', () => {
    const events = [
      drop(MetricType.OPS_PER_SEC, 0),
      event(MetricType.REPLICATION_DIVERGENCE, MIN),
      event(MetricType.MEMORY_USED, 2 * MIN),
    ];

    expect(patternsOf(events, AnomalyPattern.DIVERGENCE_UNDER_PRESSURE)).toEqual([]);
  });

  it('still takes a backlog coverage risk, which is raised as a drop, as the first step of backlog_exhaustion', () => {
    const events = [
      drop(MetricType.BACKLOG_COVERAGE_RISK, 0),
      event(MetricType.RESYNC_ESCALATION, MIN),
    ];

    expect(patternsOf(events, AnomalyPattern.BACKLOG_EXHAUSTION)).toEqual([
      AnomalyPattern.BACKLOG_EXHAUSTION,
    ]);
  });

  it('recommends raising the backlog once when backlog exhaustion and recovery amplification share an incident', () => {
    const rules = [
      ruleFor(AnomalyPattern.RECOVERY_AMPLIFICATION),
      ruleFor(AnomalyPattern.BACKLOG_EXHAUSTION),
    ];
    const [incident] = new IncidentTimelineBuilder({}, (id) => id, () => rules).build(
      [
        event(MetricType.BACKLOG_COVERAGE_RISK, 0),
        event(MetricType.RESYNC_ESCALATION, MIN),
        event(MetricType.FORK_MEMORY_RISK, 2 * MIN),
      ],
      T0 + 60 * MIN,
      neverRecovers,
    );

    const recommendations = incident.sequenceMatches.flatMap((m) => m.recommendations);

    expect(incident.matchedPatterns).toEqual(
      expect.arrayContaining([AnomalyPattern.RECOVERY_AMPLIFICATION, AnomalyPattern.BACKLOG_EXHAUSTION]),
    );
    expect(recommendations.filter((r) => r.includes('repl-backlog-size'))).toHaveLength(1);
  });
});
