import { IncidentTimelineBuilder, RecoveryProbe, sourceMatches } from '../incident-timeline';
import '../incident-sequence-rules';
import { SequenceRule, getSequenceRules } from '../sequence-rules';
import { AnomalyEvent, AnomalyPattern, AnomalySeverity, AnomalyType, MetricType } from '../types';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const NODE_A = '10.0.0.1:6379';
const NODE_B = '10.0.0.2:6379';
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

// 'reader', 'seed' and 'node-b' are connections of one cluster; 'elsewhere' belongs to another.
const clusterOf = (connectionId: string) => (connectionId === 'elsewhere' ? 'other' : 'cluster');

function incidentsOf(events: AnomalyEvent[]) {
  return new IncidentTimelineBuilder({}, clusterOf, getSequenceRules).build(
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
    const elsewhere = { connectionId: 'node-b', nodeAddr: NODE_A };

    it('needs the same connection and node for sameConnection', () => {
      const rule = { ...baseRule, sameConnection: true };

      expect(sourceMatches(rule, onA, { ...onA })).toBe(true);
      expect(sourceMatches(rule, onA, onB)).toBe(false);
      expect(sourceMatches(rule, onA, elsewhere)).toBe(false);
    });

    it('takes any source without sameConnection', () => {
      expect(sourceMatches(baseRule, onA, onB)).toBe(true);
      expect(sourceMatches(baseRule, onA, elsewhere)).toBe(true);
    });
  });

  describe('cluster events filed under different connections', () => {
    it('matches split_brain from a divergence on the reader and a duplicate primary on the seed', () => {
      const events = [
        event(MetricType.TOPOLOGY_DIVERGENCE, 0, { connectionId: 'reader' }),
        event(MetricType.CLUSTER_TOPOLOGY, MIN),
      ];

      expect(patternsOf(events)).toEqual([AnomalyPattern.SPLIT_BRAIN]);
    });

    it('matches hot_shard_latency from a hot shard on the seed and a P99 rise on a node', () => {
      const events = [
        event(MetricType.HOT_SHARD, 0, { nodeAddr: NODE_A }),
        event(MetricType.COMMAND_P99, 4 * MIN, { connectionId: 'node-b', nodeAddr: NODE_B }),
      ];

      expect(patternsOf(events)).toEqual([AnomalyPattern.HOT_SHARD_LATENCY]);
    });

    it('takes in an optional signal from a third connection after a quiet gap', () => {
      const events = [
        event(MetricType.TOPOLOGY_DIVERGENCE, 0, { connectionId: 'reader' }),
        event(MetricType.CLUSTER_TOPOLOGY, MIN),
        event(MetricType.REPLICATION_ROLE, 6 * MIN, { connectionId: 'node-b' }),
      ];
      const incidents = incidentsOf(events);

      expect(incidents).toHaveLength(1);
      expect(incidents[0].sequenceMatches[0].anomalyIds).toEqual(events.map((e) => e.id));
    });
  });

  const clusterChains: [AnomalyPattern, MetricType, MetricType][] = [
    [AnomalyPattern.SPLIT_BRAIN, MetricType.TOPOLOGY_DIVERGENCE, MetricType.CLUSTER_TOPOLOGY],
    [AnomalyPattern.HOT_SHARD_LATENCY, MetricType.HOT_SHARD, MetricType.COMMAND_P99],
    [AnomalyPattern.MIGRATION_REDIRECTS, MetricType.SLOT_MIGRATION, MetricType.ERROR_REPLIES],
    [AnomalyPattern.MEMBERSHIP_FAILOVER, MetricType.GHOST_MEMBERSHIP, MetricType.FAILOVER_CHURN],
  ];

  describe.each(clusterChains)('%s', (pattern, first, second) => {
    it('matches across connections of one cluster', () => {
      const events = [
        event(first, 0, { connectionId: 'reader' }),
        event(second, MIN, { connectionId: 'node-b' }),
      ];

      expect(patternsOf(events)).toEqual([pattern]);
    });

    it('does not chain two clusters', () => {
      const events = [event(first, 0), event(second, MIN, { connectionId: 'elsewhere' })];

      expect(patternsOf(events)).toEqual([]);
    });
  });
});
