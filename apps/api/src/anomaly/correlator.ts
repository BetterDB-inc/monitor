import { randomUUID } from 'crypto';
import {
  AnomalyEvent,
  CorrelatedAnomalyGroup,
  AnomalyPattern,
  AnomalySeverity,
  MetricType,
  AnomalyType,
} from './types';

interface PatternRule {
  pattern: AnomalyPattern;
  requiredMetrics: MetricType[];
  optionalMetrics?: MetricType[];
  diagnosis: string;
  recommendations: string[];
  check?: (anomalies: AnomalyEvent[]) => boolean;
}

export class Correlator {
  private readonly correlationWindowMs: number;
  private readonly patternRules: PatternRule[];

  constructor(correlationWindowMs: number = 5000) {
    this.correlationWindowMs = correlationWindowMs;
    this.patternRules = this.initializePatternRules();
  }

  private initializePatternRules(): PatternRule[] {
    return [
      {
        pattern: AnomalyPattern.AUTH_ATTACK,
        requiredMetrics: [MetricType.ACL_DENIED],
        diagnosis: 'Potential authentication attack detected with high ACL denial rate',
        recommendations: [
          'Review ACL denied clients in the audit trail',
          'Check for suspicious IP addresses or patterns',
          'Consider implementing rate limiting or IP blocking',
          'Verify ACL rules are configured correctly',
        ],
      },
      {
        pattern: AnomalyPattern.SLOW_QUERIES,
        requiredMetrics: [MetricType.SLOWLOG_COUNT],
        diagnosis: 'Slow query spike detected',
        recommendations: [
          'Review slow log entries to identify problematic commands',
          'Check for operations on large data structures',
          'Consider optimizing data access patterns',
          'Monitor blocked clients for potential deadlocks',
        ],
      },
      {
        pattern: AnomalyPattern.MEMORY_PRESSURE,
        requiredMetrics: [MetricType.MEMORY_USED],
        optionalMetrics: [MetricType.EVICTED_KEYS, MetricType.FRAGMENTATION_RATIO],
        check: (anomalies) => {
          const hasMemorySpike = anomalies.some(a =>
            a.metricType === MetricType.MEMORY_USED && a.anomalyType === AnomalyType.SPIKE
          );
          const hasEvictions = anomalies.some(a => a.metricType === MetricType.EVICTED_KEYS);
          return hasMemorySpike && (hasEvictions || anomalies.length === 1);
        },
        diagnosis: 'Memory pressure detected with potential evictions',
        recommendations: [
          'Check memory usage trends and plan for scaling',
          'Review eviction policy settings',
          'Identify large keys or data structures',
          'Consider increasing maxmemory or adding shards',
        ],
      },
      {
        pattern: AnomalyPattern.CACHE_THRASHING,
        requiredMetrics: [MetricType.KEYSPACE_MISSES, MetricType.EVICTED_KEYS],
        diagnosis: 'Cache thrashing detected with high miss rate and evictions',
        recommendations: [
          'Review cache hit ratio trends',
          'Check if working set exceeds available memory',
          'Consider increasing memory or adjusting TTLs',
          'Analyze access patterns for optimization opportunities',
        ],
      },
      {
        pattern: AnomalyPattern.CONNECTION_LEAK,
        requiredMetrics: [MetricType.CONNECTIONS],
        check: (anomalies) => {
          const connAnomaly = anomalies.find(a => a.metricType === MetricType.CONNECTIONS);
          if (!connAnomaly || connAnomaly.anomalyType !== AnomalyType.SPIKE) return false;

          // Connection leak: connections spike but ops remain stable
          const hasOpsAnomaly = anomalies.some(a => a.metricType === MetricType.OPS_PER_SEC);
          return !hasOpsAnomaly;
        },
        diagnosis: 'Potential connection leak: connections increasing without corresponding traffic',
        recommendations: [
          'Check for idle connections in client analytics',
          'Review client applications for connection pool leaks',
          'Set timeout parameters (timeout, tcp-keepalive)',
          'Monitor connection creation vs. closure rates',
        ],
      },
      {
        pattern: AnomalyPattern.BATCH_JOB,
        requiredMetrics: [MetricType.CONNECTIONS, MetricType.OPS_PER_SEC],
        optionalMetrics: [MetricType.MEMORY_USED],
        check: (anomalies) => {
          const hasConnSpike = anomalies.some(a =>
            a.metricType === MetricType.CONNECTIONS && a.anomalyType === AnomalyType.SPIKE
          );
          const hasOpsSpike = anomalies.some(a =>
            a.metricType === MetricType.OPS_PER_SEC && a.anomalyType === AnomalyType.SPIKE
          );
          const hasMemorySpike = anomalies.some(a =>
            a.metricType === MetricType.MEMORY_USED && a.anomalyType === AnomalyType.SPIKE
          );

          return hasConnSpike && hasOpsSpike && hasMemorySpike;
        },
        diagnosis: 'Batch job or bulk operation detected with concurrent spikes in connections, operations, and memory',
        recommendations: [
          'Identify the client or job causing the spike',
          'Consider scheduling batch jobs during off-peak hours',
          'Implement rate limiting for bulk operations',
          'Monitor job duration and resource usage',
        ],
      },
      {
        pattern: AnomalyPattern.TRAFFIC_BURST,
        requiredMetrics: [MetricType.CONNECTIONS, MetricType.OPS_PER_SEC],
        check: (anomalies) => {
          const hasConnSpike = anomalies.some(a =>
            a.metricType === MetricType.CONNECTIONS && a.anomalyType === AnomalyType.SPIKE
          );
          const hasOpsSpike = anomalies.some(a =>
            a.metricType === MetricType.OPS_PER_SEC && a.anomalyType === AnomalyType.SPIKE
          );

          // Traffic burst: connections and ops spike, but NOT memory
          const hasMemorySpike = anomalies.some(a =>
            a.metricType === MetricType.MEMORY_USED && a.anomalyType === AnomalyType.SPIKE
          );

          return hasConnSpike && hasOpsSpike && !hasMemorySpike;
        },
        diagnosis: 'Traffic burst detected with increased connections and operations',
        recommendations: [
          'Monitor traffic patterns for recurring spikes',
          'Ensure sufficient capacity for peak loads',
          'Review client connection pooling settings',
          'Consider implementing auto-scaling if cloud-hosted',
        ],
      },
    ];
  }

  correlate(anomalies: AnomalyEvent[]): CorrelatedAnomalyGroup[] {
    if (anomalies.length === 0) return [];

    // Sort by timestamp
    const sorted = [...anomalies].sort((a, b) => a.timestamp - b.timestamp);

    // Group anomalies by time windows
    const windows: AnomalyEvent[][] = [];
    let currentWindow: AnomalyEvent[] = [];
    let windowStart = sorted[0].timestamp;

    for (const anomaly of sorted) {
      if (anomaly.timestamp - windowStart <= this.correlationWindowMs) {
        currentWindow.push(anomaly);
      } else {
        if (currentWindow.length > 0) {
          windows.push(currentWindow);
        }
        currentWindow = [anomaly];
        windowStart = anomaly.timestamp;
      }
    }

    if (currentWindow.length > 0) {
      windows.push(currentWindow);
    }

    // Correlate each window
    const groups: CorrelatedAnomalyGroup[] = [];

    for (const windowAnomalies of windows) {
      // Single anomaly - may still match a pattern
      if (windowAnomalies.length === 1) {
        const pattern = this.detectPattern(windowAnomalies);
        if (pattern) {
          groups.push(this.createGroup(windowAnomalies, pattern));
        } else {
          // Single anomaly without specific pattern
          groups.push(this.createGroup(windowAnomalies, {
            pattern: AnomalyPattern.UNKNOWN,
            requiredMetrics: [],
            diagnosis: `${windowAnomalies[0].metricType} anomaly detected`,
            recommendations: ['Investigate the specific metric trend', 'Check for related system events'],
          }));
        }
      } else {
        // Multiple anomalies - detect pattern
        const pattern = this.detectPattern(windowAnomalies);
        if (pattern) {
          groups.push(this.createGroup(windowAnomalies, pattern));
        } else {
          // Multiple anomalies but no specific pattern match
          groups.push(this.createGroup(windowAnomalies, {
            pattern: AnomalyPattern.UNKNOWN,
            requiredMetrics: [],
            diagnosis: `Multiple concurrent anomalies detected: ${windowAnomalies.map(a => a.metricType).join(', ')}`,
            recommendations: [
              'Investigate correlation between affected metrics',
              'Check for external system events or changes',
              'Review application behavior during this time',
            ],
          }));
        }
      }
    }

    return groups;
  }

  private detectPattern(anomalies: AnomalyEvent[]): PatternRule | null {
    const metricTypes = new Set(anomalies.map(a => a.metricType));

    // Check each pattern rule
    for (const rule of this.patternRules) {
      // Check if all required metrics are present
      const hasAllRequired = rule.requiredMetrics.every(m => metricTypes.has(m));
      if (!hasAllRequired) continue;

      // If there's a custom check function, use it
      if (rule.check) {
        if (rule.check(anomalies)) {
          return rule;
        }
      } else {
        // No custom check - just required metrics match
        return rule;
      }
    }

    return null;
  }

  private createGroup(anomalies: AnomalyEvent[], rule: PatternRule): CorrelatedAnomalyGroup {
    const correlationId = randomUUID();

    // Update correlation ID on all anomalies
    anomalies.forEach(a => {
      a.correlationId = correlationId;
      a.relatedMetrics = anomalies
        .filter(other => other.id !== a.id)
        .map(other => other.metricType);
    });

    // Determine overall severity (highest severity wins)
    const severityOrder = {
      [AnomalySeverity.INFO]: 0,
      [AnomalySeverity.WARNING]: 1,
      [AnomalySeverity.CRITICAL]: 2,
    };

    const maxSeverity = anomalies.reduce((max, a) => {
      return severityOrder[a.severity] > severityOrder[max] ? a.severity : max;
    }, AnomalySeverity.INFO);

    return {
      correlationId,
      timestamp: Math.min(...anomalies.map(a => a.timestamp)),
      anomalies,
      pattern: rule.pattern,
      diagnosis: rule.diagnosis,
      recommendations: rule.recommendations,
      severity: maxSeverity,
    };
  }

  getPatternDescription(pattern: AnomalyPattern): string {
    const rule = this.patternRules.find(r => r.pattern === pattern);
    return rule?.diagnosis || 'Unknown pattern';
  }

  getPatternRecommendations(pattern: AnomalyPattern): string[] {
    const rule = this.patternRules.find(r => r.pattern === pattern);
    return rule?.recommendations || [];
  }
}
