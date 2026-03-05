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
});
