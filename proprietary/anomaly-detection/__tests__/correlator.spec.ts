import { Correlator } from '../correlator';
import {
  AnomalyEvent,
  AnomalyPattern,
  AnomalySeverity,
  AnomalyType,
  MetricType,
} from '../types';

function makeAnomaly(overrides: Partial<AnomalyEvent> = {}): AnomalyEvent {
  return {
    id: `anomaly-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    metricType: MetricType.CONNECTIONS,
    anomalyType: AnomalyType.SPIKE,
    severity: AnomalySeverity.WARNING,
    value: 100,
    baseline: 50,
    stdDev: 10,
    zScore: 5,
    threshold: 2,
    message: 'test anomaly',
    resolved: false,
    ...overrides,
  };
}

describe('Correlator', () => {
  let correlator: Correlator;

  beforeEach(() => {
    correlator = new Correlator(5000);
  });

  describe('CONTROL_PLANE_SATURATION pattern', () => {
    const saturationMarker = (overrides: Partial<AnomalyEvent> = {}) =>
      makeAnomaly({
        metricType: MetricType.CPU_UTILIZATION,
        severity: AnomalySeverity.CRITICAL,
        zScore: 0,
        threshold: 90,
        value: 96,
        message: 'CRITICAL: Engine near CPU saturation with control-plane impact (valkey#3927)',
        syntheticPattern: AnomalyPattern.CONTROL_PLANE_SATURATION,
        ...overrides,
      });

    it('matches the synthetic saturation marker event', () => {
      const groups = correlator.correlate([saturationMarker()]);
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.CONTROL_PLANE_SATURATION);
      expect(groups[0].diagnosis).toContain('valkey#3927');
      expect(groups[0].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('does not match an ordinary z-score CPU anomaly', () => {
      const zScoreCpu = makeAnomaly({
        metricType: MetricType.CPU_UTILIZATION,
        severity: AnomalySeverity.CRITICAL,
        zScore: 4.5,
        threshold: 3,
      });
      const groups = correlator.correlate([zScoreCpu]);
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).not.toBe(AnomalyPattern.CONTROL_PLANE_SATURATION);
    });

    it('wins over NODE_FAILOVER in a mixed window containing its side effects', () => {
      const ts = Date.now();
      const groups = correlator.correlate([
        saturationMarker({ timestamp: ts }),
        makeAnomaly({
          metricType: MetricType.REPLICATION_ROLE,
          anomalyType: AnomalyType.DROP,
          severity: AnomalySeverity.CRITICAL,
          timestamp: ts + 1000,
        }),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.CONTROL_PLANE_SATURATION);
    });
  });

  describe('NODE_FAILOVER pattern', () => {
    it('matches on REPLICATION_ROLE metric', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.REPLICATION_ROLE,
        anomalyType: AnomalyType.DROP,
        severity: AnomalySeverity.CRITICAL,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.NODE_FAILOVER);
    });

    it('matches on CLUSTER_STATE metric', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.CLUSTER_STATE,
        anomalyType: AnomalyType.DROP,
        severity: AnomalySeverity.CRITICAL,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.NODE_FAILOVER);
    });

    it('provides correct diagnosis and recommendations', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.REPLICATION_ROLE,
        anomalyType: AnomalyType.DROP,
        severity: AnomalySeverity.CRITICAL,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups[0].diagnosis).toContain('Node failover detected');
      expect(groups[0].recommendations).toContain(
        'Verify the new primary is healthy and accepting writes',
      );
      expect(groups[0].recommendations).toContain(
        'Confirm no split-brain scenario exists',
      );
    });

    it('propagates CRITICAL severity from anomaly', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.REPLICATION_ROLE,
        anomalyType: AnomalyType.DROP,
        severity: AnomalySeverity.CRITICAL,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups[0].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('groups NODE_FAILOVER + SLOWLOG_LAST_ID in same window into single CorrelatedGroup', () => {
      const baseTime = 1000000;
      const groups = correlator.correlate([
        makeAnomaly({
          timestamp: baseTime,
          metricType: MetricType.REPLICATION_ROLE,
          anomalyType: AnomalyType.DROP,
          severity: AnomalySeverity.CRITICAL,
        }),
        makeAnomaly({
          timestamp: baseTime + 2000,
          metricType: MetricType.SLOWLOG_LAST_ID,
          anomalyType: AnomalyType.SPIKE,
          severity: AnomalySeverity.WARNING,
        }),
      ]);

      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.NODE_FAILOVER);
      expect(groups[0].anomalies).toHaveLength(2);
      expect(groups[0].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('includes slowlog context in diagnosis when SLOWLOG_LAST_ID co-occurs', () => {
      const baseTime = 1000000;
      const groups = correlator.correlate([
        makeAnomaly({
          timestamp: baseTime,
          metricType: MetricType.REPLICATION_ROLE,
          anomalyType: AnomalyType.DROP,
          severity: AnomalySeverity.CRITICAL,
        }),
        makeAnomaly({
          timestamp: baseTime + 1000,
          metricType: MetricType.SLOWLOG_LAST_ID,
          anomalyType: AnomalyType.SPIKE,
        }),
      ]);

      expect(groups[0].diagnosis).toContain('correlated slowlog spike');
    });

    it('diagnosis is failover-only when no slowlog spike co-occurs', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.REPLICATION_ROLE,
        anomalyType: AnomalyType.DROP,
        severity: AnomalySeverity.CRITICAL,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups[0].diagnosis).toContain('Node failover detected');
      expect(groups[0].diagnosis).not.toContain('slowlog');
    });
  });

  describe('SLOW_QUERIES pattern', () => {
    it('matches on SLOWLOG_LAST_ID metric', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.SLOWLOG_LAST_ID,
        anomalyType: AnomalyType.SPIKE,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.SLOW_QUERIES);
    });

    it('does NOT match on legacy SLOWLOG_COUNT metric', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.SLOWLOG_COUNT,
        anomalyType: AnomalyType.SPIKE,
      });

      const groups = correlator.correlate([anomaly]);
      const slowQueryGroups = groups.filter(
        (g) => g.pattern === AnomalyPattern.SLOW_QUERIES,
      );
      expect(slowQueryGroups).toHaveLength(0);
    });

    it('has updated diagnosis text about rate spike', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.SLOWLOG_LAST_ID,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups[0].diagnosis).toContain('Slow query rate spike detected');
      expect(groups[0].diagnosis).toContain('elevated rate of new slow queries per interval');
    });
  });

  describe('time windowing', () => {
    it('groups anomalies within the correlation window', () => {
      const baseTime = 1000000;
      const a1 = makeAnomaly({
        timestamp: baseTime,
        metricType: MetricType.CONNECTIONS,
        anomalyType: AnomalyType.SPIKE,
      });
      const a2 = makeAnomaly({
        timestamp: baseTime + 2000, // within 5s window
        metricType: MetricType.OPS_PER_SEC,
        anomalyType: AnomalyType.SPIKE,
      });

      const groups = correlator.correlate([a1, a2]);
      expect(groups).toHaveLength(1);
      expect(groups[0].anomalies).toHaveLength(2);
    });

    it('splits anomalies across different windows', () => {
      const baseTime = 1000000;
      const a1 = makeAnomaly({
        timestamp: baseTime,
        metricType: MetricType.CONNECTIONS,
      });
      const a2 = makeAnomaly({
        timestamp: baseTime + 10000, // 10s later → different window
        metricType: MetricType.OPS_PER_SEC,
      });

      const groups = correlator.correlate([a1, a2]);
      expect(groups).toHaveLength(2);
    });
  });

  describe('COMMAND_P99 input', () => {
    it('maps a standalone P99 regression to SLOW_QUERIES', () => {
      const groups = correlator.correlate([makeAnomaly({ metricType: MetricType.COMMAND_P99 })]);

      expect(groups[0].pattern).toBe(AnomalyPattern.SLOW_QUERIES);
      expect(groups[0].diagnosis).toContain('P99');
    });

    it('lets a co-occurring failover take precedence', () => {
      const t = 1_000_000;
      const groups = correlator.correlate([
        makeAnomaly({ timestamp: t, metricType: MetricType.REPLICATION_ROLE }),
        makeAnomaly({ timestamp: t + 1000, metricType: MetricType.COMMAND_P99 }),
      ]);

      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.NODE_FAILOVER);
    });
  });

  describe('scope partitioning', () => {
    it('keeps anomalies from different connections in separate groups', () => {
      const baseTime = 1000000;
      const a1 = makeAnomaly({
        timestamp: baseTime,
        metricType: MetricType.CONNECTIONS,
        connectionId: 'conn-a',
      });
      const a2 = makeAnomaly({
        timestamp: baseTime + 1000,
        metricType: MetricType.OPS_PER_SEC,
        connectionId: 'conn-b',
      });

      const groups = correlator.correlate([a1, a2]);

      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.anomalies[0].connectionId)).toEqual(['conn-a', 'conn-b']);
    });

    it('groups nodes that resolve to the same scope', () => {
      const scoped = new Correlator(5000, (a) => (a.connectionId === 'node-2' ? 'seed' : a.connectionId ?? ''));
      const baseTime = 1000000;
      const roleChange = makeAnomaly({
        timestamp: baseTime,
        metricType: MetricType.REPLICATION_ROLE,
        connectionId: 'node-2',
      });
      const slowlog = makeAnomaly({
        timestamp: baseTime + 1000,
        metricType: MetricType.SLOWLOG_LAST_ID,
        connectionId: 'seed',
      });

      const groups = scoped.correlate([roleChange, slowlog]);

      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.NODE_FAILOVER);
      expect(groups[0].anomalies).toHaveLength(2);
    });

    it('returns groups in chronological order across scopes', () => {
      const baseTime = 1000000;
      const late = makeAnomaly({ timestamp: baseTime + 3000, connectionId: 'conn-a' });
      const early = makeAnomaly({ timestamp: baseTime, connectionId: 'conn-b' });

      const groups = correlator.correlate([late, early]);

      expect(groups.map((g) => g.timestamp)).toEqual([baseTime, baseTime + 3000]);
    });
  });

  describe('single metric pattern matching', () => {
    it('matches ACL_DENIED to AUTH_ATTACK pattern', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.ACL_DENIED,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups[0].pattern).toBe(AnomalyPattern.AUTH_ATTACK);
    });

    it('matches FRAGMENTATION_RATIO to MEMORY_PRESSURE pattern', () => {
      const anomaly = makeAnomaly({
        metricType: MetricType.FRAGMENTATION_RATIO,
      });

      const groups = correlator.correlate([anomaly]);
      expect(groups[0].pattern).toBe(AnomalyPattern.MEMORY_PRESSURE);
    });
  });

  describe('related metrics', () => {
    it('keeps detector-stamped related metrics after grouping', () => {
      const baseTime = 1000000;
      const stamped = makeAnomaly({
        timestamp: baseTime,
        metricType: MetricType.CONNECTIONS,
        relatedMetrics: [MetricType.MEMORY_USED],
      });
      correlator.correlate([
        stamped,
        makeAnomaly({ timestamp: baseTime + 1000, metricType: MetricType.OPS_PER_SEC }),
      ]);

      expect(stamped.relatedMetrics).toEqual([MetricType.MEMORY_USED, MetricType.OPS_PER_SEC]);
    });

    it('sets the other members for an unstamped event', () => {
      const baseTime = 1000000;
      const unstamped = makeAnomaly({ timestamp: baseTime, metricType: MetricType.CONNECTIONS });
      correlator.correlate([
        unstamped,
        makeAnomaly({ timestamp: baseTime + 1000, metricType: MetricType.OPS_PER_SEC }),
      ]);

      expect(unstamped.relatedMetrics).toEqual([MetricType.OPS_PER_SEC]);
    });
  });

  describe('multi-metric pattern matching', () => {
    it('detects TRAFFIC_BURST when connections and ops spike without memory', () => {
      const baseTime = 1000000;
      const groups = correlator.correlate([
        makeAnomaly({
          timestamp: baseTime,
          metricType: MetricType.CONNECTIONS,
          anomalyType: AnomalyType.SPIKE,
        }),
        makeAnomaly({
          timestamp: baseTime + 1000,
          metricType: MetricType.OPS_PER_SEC,
          anomalyType: AnomalyType.SPIKE,
        }),
      ]);

      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.TRAFFIC_BURST);
    });

    it('falls back to UNKNOWN when no pattern matches', () => {
      const baseTime = 1000000;
      // INPUT_KBPS + BLOCKED_CLIENTS → no specific multi-metric pattern
      const groups = correlator.correlate([
        makeAnomaly({
          timestamp: baseTime,
          metricType: MetricType.INPUT_KBPS,
          anomalyType: AnomalyType.SPIKE,
        }),
        makeAnomaly({
          timestamp: baseTime + 1000,
          metricType: MetricType.BLOCKED_CLIENTS,
          anomalyType: AnomalyType.SPIKE,
        }),
      ]);

      // Both match single-metric patterns individually, but grouped together
      // the first matching rule wins — INPUT_KBPS matches TRAFFIC_BURST single-metric rule
      // since it only requires INPUT_KBPS
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.TRAFFIC_BURST);
    });
  });

  describe('severity propagation', () => {
    it('takes highest severity from anomalies in a group', () => {
      const baseTime = 1000000;
      const groups = correlator.correlate([
        makeAnomaly({
          timestamp: baseTime,
          metricType: MetricType.CONNECTIONS,
          severity: AnomalySeverity.WARNING,
          anomalyType: AnomalyType.SPIKE,
        }),
        makeAnomaly({
          timestamp: baseTime + 1000,
          metricType: MetricType.OPS_PER_SEC,
          severity: AnomalySeverity.CRITICAL,
          anomalyType: AnomalyType.SPIKE,
        }),
      ]);

      expect(groups[0].severity).toBe(AnomalySeverity.CRITICAL);
    });
  });

  describe('correlation metadata', () => {
    it('assigns correlationId and relatedMetrics to anomalies', () => {
      const baseTime = 1000000;
      const a1 = makeAnomaly({
        timestamp: baseTime,
        metricType: MetricType.CONNECTIONS,
        anomalyType: AnomalyType.SPIKE,
      });
      const a2 = makeAnomaly({
        timestamp: baseTime + 1000,
        metricType: MetricType.OPS_PER_SEC,
        anomalyType: AnomalyType.SPIKE,
      });

      const groups = correlator.correlate([a1, a2]);
      expect(a1.correlationId).toBe(groups[0].correlationId);
      expect(a2.correlationId).toBe(groups[0].correlationId);
      expect(a1.relatedMetrics).toContain(MetricType.OPS_PER_SEC);
      expect(a2.relatedMetrics).toContain(MetricType.CONNECTIONS);
    });
  });

  describe('empty input', () => {
    it('returns empty array for empty anomalies', () => {
      expect(correlator.correlate([])).toEqual([]);
    });
  });

  describe('getPatternDescription / getPatternRecommendations', () => {
    it('returns diagnosis for known pattern', () => {
      const desc = correlator.getPatternDescription(AnomalyPattern.NODE_FAILOVER);
      expect(desc).toContain('Node failover detected');
    });

    it('returns "Unknown pattern" for unregistered pattern', () => {
      expect(correlator.getPatternDescription('nonexistent' as AnomalyPattern)).toBe('Unknown pattern');
    });

    it('returns recommendations for known pattern', () => {
      const recs = correlator.getPatternRecommendations(AnomalyPattern.SLOW_QUERIES);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs).toContain('Review slow log entries to identify problematic commands');
    });
  });

  describe('REPLICATION_DIVERGENCE pattern', () => {
    const divergence = (overrides: Partial<AnomalyEvent> = {}) =>
      makeAnomaly({
        metricType: MetricType.REPLICATION_DIVERGENCE,
        zScore: 0,
        message: 'WARNING: Replica 10.0.0.2:6379 is 8.0 MiB behind the primary',
        connectionId: 'c1',
        ...overrides,
      });

    it('reads a lone warning as a transient burst', () => {
      const groups = correlator.correlate([divergence()]);
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.REPLICATION_DIVERGENCE);
      expect(groups[0].diagnosis).toContain('watching whether it catches up');
    });

    it('reads a critical divergence as sustained', () => {
      const [group] = correlator.correlate([divergence({ severity: AnomalySeverity.CRITICAL })]);
      expect(group.diagnosis).toContain('Sustained replication divergence');
    });

    it('groups divergence with memory pressure into one compound diagnosis', () => {
      const now = Date.now();
      const groups = correlator.correlate([
        divergence({ timestamp: now }),
        makeAnomaly({ metricType: MetricType.MEMORY_USED, timestamp: now + 100, connectionId: 'c1' }),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].pattern).toBe(AnomalyPattern.REPLICATION_DIVERGENCE);
      expect(groups[0].diagnosis).toContain('alongside memory growth');
    });

    it('names signals the detector stamped from outside the correlation window', () => {
      const [group] = correlator.correlate([
        divergence({
          relatedMetrics: [MetricType.REPL_BUFFER_PRESSURE, MetricType.CLUSTER_TOPOLOGY],
        }),
      ]);
      expect(group.diagnosis).toContain('replica output-buffer pressure');
      expect(group.diagnosis).toContain('slot migration');
    });

    it('keeps stamped related metrics after grouping', () => {
      const now = Date.now();
      const stamped = divergence({ timestamp: now, relatedMetrics: [MetricType.FORK_MEMORY_RISK] });
      correlator.correlate([
        stamped,
        makeAnomaly({ metricType: MetricType.MEMORY_USED, timestamp: now + 100, connectionId: 'c1' }),
      ]);
      expect(stamped.relatedMetrics).toEqual(
        expect.arrayContaining([MetricType.FORK_MEMORY_RISK, MetricType.MEMORY_USED]),
      );
    });
  });
});
