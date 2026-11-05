import { IncidentTimelineBuilder, RecoveryProbe } from '../incident-timeline';
import {
  BACKLOG_EXHAUSTION_MAX_SPAN_MS,
  DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS,
  RESHARD_UNDER_WRITES_MAX_SPAN_MS,
  RETRY_STORM_MAX_SPAN_MS,
} from '../incident-sequence-rules';
import { RESYNC_ESCALATION_WINDOW_MS } from '../recovery-amplification-detector';
import { SequenceRule, getSequenceRules } from '../sequence-rules';
import { AnomalyEvent, AnomalyPattern, AnomalySeverity, AnomalyType, MetricType } from '../types';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const neverRecovers: RecoveryProbe = () => null;

let seq = 0;
function event(metricType: MetricType, at: number, connectionId = 'conn-a'): AnomalyEvent {
  seq++;
  return {
    id: `evt-${String(seq).padStart(3, '0')}`,
    timestamp: T0 + at,
    metricType,
    anomalyType: AnomalyType.SPIKE,
    severity: AnomalySeverity.WARNING,
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

function patternsOf(events: AnomalyEvent[], pattern: AnomalyPattern, scope = (id: string) => id) {
  const incidents = new IncidentTimelineBuilder({}, scope, () => [ruleFor(pattern)]).build(
    events,
    T0 + 60 * MIN,
    neverRecovers,
  );
  return incidents.flatMap((incident) => incident.matchedPatterns);
}

interface RuleCase {
  pattern: AnomalyPattern;
  steps: MetricType[];
  optional?: MetricType;
  spanMs: number;
  lead?: { step: number; ms: number };
  sameConnection: boolean;
}

const cases: RuleCase[] = [
  {
    pattern: AnomalyPattern.DIVERGENCE_UNDER_PRESSURE,
    steps: [MetricType.INPUT_KBPS, MetricType.REPLICATION_DIVERGENCE, MetricType.REPL_BUFFER_PRESSURE],
    optional: MetricType.EVICTED_KEYS,
    spanMs: DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS,
    lead: { step: 2, ms: DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS },
    sameConnection: true,
  },
  {
    pattern: AnomalyPattern.RESHARD_UNDER_WRITES,
    steps: [MetricType.RESHARD_SHARD_SKEW, MetricType.REPLICATION_DIVERGENCE],
    optional: MetricType.COMMAND_P99,
    spanMs: RESHARD_UNDER_WRITES_MAX_SPAN_MS,
    sameConnection: false,
  },
  {
    pattern: AnomalyPattern.RETRY_STORM,
    steps: [MetricType.ERROR_REPLIES, MetricType.RETRY_AMPLIFICATION, MetricType.CLIENT_LOCKOUT_RISK],
    optional: MetricType.CONNECTION_CHURN,
    spanMs: RETRY_STORM_MAX_SPAN_MS,
    lead: { step: 2, ms: RETRY_STORM_MAX_SPAN_MS },
    sameConnection: true,
  },
  {
    pattern: AnomalyPattern.BACKLOG_EXHAUSTION,
    steps: [MetricType.BACKLOG_COVERAGE_RISK, MetricType.RESYNC_ESCALATION],
    spanMs: BACKLOG_EXHAUSTION_MAX_SPAN_MS,
    lead: { step: 1, ms: RESYNC_ESCALATION_WINDOW_MS },
    sameConnection: true,
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

  describe.each(cases)('$pattern', ({ pattern, steps, optional, spanMs, lead, sameConnection }) => {
    const inOrder = (gapMs = MIN) => steps.map((metric, i) => event(metric, i * gapMs));

    it('matches its steps in order', () => {
      expect(patternsOf(inOrder(), pattern)).toEqual([pattern]);
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
