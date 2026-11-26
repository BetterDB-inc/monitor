import { IncidentTimelineBuilder, RecoveryProbe, sourceMatches } from '../incident-timeline';
import '../incident-sequence-rules';
import { SequenceRule, getSequenceRules, registerSequenceRule } from '../sequence-rules';
import { AnomalyEvent, AnomalyPattern, AnomalySeverity, AnomalyType, MetricType } from '../types';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const NODE_A = '10.0.0.1:6379';
const NODE_B = '10.0.0.2:6379';
const NODE_C = '10.0.0.3:6379';
const neverRecovers: RecoveryProbe = () => null;

let seq = 0;
function event(
  metricType: MetricType,
  at: number,
  { connectionId = 'seed', nodeAddr }: { connectionId?: string; nodeAddr?: string } = {},
): AnomalyEvent {
  seq++;
  return {
    id: `evt-${String(seq).padStart(3, '0')}`,
    timestamp: T0 + at,
    metricType,
    anomalyType: AnomalyType.SPIKE,
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
    ...(nodeAddr ? { nodeAddr } : {}),
  };
}

// Every connection resolves to one cluster, so only the rule decides what chains.
function incidentsOf(events: AnomalyEvent[]) {
  return new IncidentTimelineBuilder({}, () => 'cluster', getSequenceRules).build(
    events,
    T0 + 60 * MIN,
    neverRecovers,
  );
}

function patternsOf(events: AnomalyEvent[]) {
  return incidentsOf(events).flatMap((incident) => incident.matchedPatterns);
}

const baseRule: SequenceRule = {
  pattern: AnomalyPattern.BATCH_JOB,
  steps: [[MetricType.OPS_PER_SEC], [MetricType.MEMORY_USED]],
  maxSpanMs: MIN,
  diagnosis: 'd',
  recommendations: [],
};

describe('sequence rule source scope', () => {
  beforeEach(() => {
    seq = 0;
  });

  describe('sourceMatches', () => {
    const onA = { connectionId: 'seed', nodeAddr: NODE_A };
    const onB = { connectionId: 'seed', nodeAddr: NODE_B };
    const elsewhere = { connectionId: 'other', nodeAddr: NODE_A };

    it('needs the same connection and node for sameConnection', () => {
      const rule = { ...baseRule, sameConnection: true };

      expect(sourceMatches(rule, onA, { ...onA })).toBe(true);
      expect(sourceMatches(rule, onA, onB)).toBe(false);
      expect(sourceMatches(rule, onA, elsewhere)).toBe(false);
    });

    it('needs only the same connection for sameConnectionAnyNode', () => {
      const rule = { ...baseRule, sameConnectionAnyNode: true };

      expect(sourceMatches(rule, onA, onB)).toBe(true);
      expect(sourceMatches(rule, onA, { connectionId: 'seed' })).toBe(true);
      expect(sourceMatches(rule, onA, elsewhere)).toBe(false);
    });

    it('takes any source when the rule sets neither', () => {
      expect(sourceMatches(baseRule, onA, elsewhere)).toBe(true);
    });
  });

  it('rejects a rule that sets both scopes', () => {
    expect(() =>
      registerSequenceRule({ ...baseRule, sameConnection: true, sameConnectionAnyNode: true }),
    ).toThrow(/both sameConnection and sameConnectionAnyNode/);
    expect(getSequenceRules().map((r) => r.pattern)).not.toContain(baseRule.pattern);
  });

  describe('across the nodes of one connection', () => {
    it('matches split_brain from a divergence on one node and a duplicate primary on another', () => {
      const events = [
        event(MetricType.TOPOLOGY_DIVERGENCE, 0, { nodeAddr: NODE_A }),
        event(MetricType.CLUSTER_TOPOLOGY, 5 * MIN, { nodeAddr: NODE_B }),
      ];
      const incidents = incidentsOf(events);

      expect(incidents).toHaveLength(1);
      expect(incidents[0].matchedPatterns).toEqual([AnomalyPattern.SPLIT_BRAIN]);
    });

    it('matches hot_shard_latency from a node hot shard and a seed P99 rise', () => {
      const events = [
        event(MetricType.HOT_SHARD, 0, { nodeAddr: NODE_A }),
        event(MetricType.COMMAND_P99, 4 * MIN),
      ];

      expect(patternsOf(events)).toEqual([AnomalyPattern.HOT_SHARD_LATENCY]);
    });

    it('keeps a P99 rise that leads the hot shard in the same incident', () => {
      const events = [
        event(MetricType.COMMAND_P99, 0),
        event(MetricType.HOT_SHARD, 8 * MIN, { nodeAddr: NODE_A }),
      ];
      const incidents = incidentsOf(events);

      expect(incidents).toHaveLength(1);
      expect(incidents[0].matchedPatterns).toEqual([AnomalyPattern.HOT_SHARD_LATENCY]);
    });

    it('takes in an optional signal from a third node, before and after a quiet gap', () => {
      const events = [
        event(MetricType.TOPOLOGY_DIVERGENCE, 0, { nodeAddr: NODE_A }),
        event(MetricType.CLUSTER_TOPOLOGY, MIN, { nodeAddr: NODE_B }),
        event(MetricType.FAILOVER_CHURN, 6 * MIN, { nodeAddr: NODE_C }),
      ];
      const incidents = incidentsOf(events);

      expect(incidents).toHaveLength(1);
      expect(incidents[0].sequenceMatches[0].anomalyIds).toEqual(events.map((e) => e.id));
    });
  });

  const clusterChains: [AnomalyPattern, MetricType, MetricType, MetricType][] = [
    [
      AnomalyPattern.SPLIT_BRAIN,
      MetricType.TOPOLOGY_DIVERGENCE,
      MetricType.CLUSTER_TOPOLOGY,
      MetricType.FAILOVER_CHURN,
    ],
    [
      AnomalyPattern.HOT_SHARD_LATENCY,
      MetricType.HOT_SHARD,
      MetricType.COMMAND_P99,
      MetricType.CLIENT_SATURATION,
    ],
    [
      AnomalyPattern.MIGRATION_REDIRECTS,
      MetricType.SLOT_MIGRATION,
      MetricType.ERROR_REPLIES,
      MetricType.RETRY_AMPLIFICATION,
    ],
    [
      AnomalyPattern.MEMBERSHIP_FAILOVER,
      MetricType.GHOST_MEMBERSHIP,
      MetricType.FAILOVER_CHURN,
      MetricType.TOPOLOGY_DIVERGENCE,
    ],
  ];

  describe.each(clusterChains)('%s', (pattern, first, second, optional) => {
    it('matches across nodes of one connection', () => {
      const events = [
        event(first, 0, { nodeAddr: NODE_A }),
        event(second, MIN, { nodeAddr: NODE_B }),
      ];

      expect(patternsOf(events)).toEqual([pattern]);
    });

    it.each([MIN, 5 * MIN])('does not chain two connections %i ms apart', (gapMs) => {
      const events = [
        event(first, 0, { connectionId: 'seed', nodeAddr: NODE_A }),
        event(second, gapMs, { connectionId: 'other', nodeAddr: NODE_A }),
      ];

      expect(patternsOf(events)).toEqual([]);
    });

    it('leaves out an optional signal from another connection', () => {
      const events = [
        event(first, 0),
        event(second, MIN),
        event(optional, 90_000, { connectionId: 'other' }),
      ];
      const [incident] = incidentsOf(events);

      expect(incident.sequenceMatches[0].anomalyIds).toEqual([events[0].id, events[1].id]);
    });
  });
});
