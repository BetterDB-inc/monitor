import { randomUUID } from 'crypto';
import {
  AnomalyEvent,
  CorrelatedAnomalyGroup,
  AnomalyPattern,
  AnomalySeverity,
  MetricType,
  AnomalyType,
} from './types';
import { isControlPlaneSaturationEvent } from './control-plane-saturation-detector';
import { DIVERGENCE_COMPOUND_SIGNALS } from './replication-divergence-detector';

interface PatternRule {
  pattern: AnomalyPattern;
  requiredMetrics: MetricType[];
  optionalMetrics?: MetricType[];
  diagnosis: string;
  recommendations: string[];
  check?: (anomalies: AnomalyEvent[]) => boolean;
}

export type CorrelationScopeResolver = (anomaly: AnomalyEvent) => string;

const DIVERGENCE_YIELDS_TO: ReadonlySet<MetricType> = new Set([
  MetricType.ACL_DENIED,
  MetricType.REPLICATION_ROLE,
  MetricType.CLUSTER_STATE,
]);

function describeReplicationDivergence(fallback: string, anomalies: AnomalyEvent[]): string {
  const divergence = anomalies.filter((a) => a.metricType === MetricType.REPLICATION_DIVERGENCE);
  const metrics = new Set<MetricType>([
    ...anomalies.map((a) => a.metricType),
    ...divergence.flatMap((a) => a.relatedMetrics ?? []),
  ]);
  const signals = [
    ...new Set(
      [...metrics]
        .map((m) => DIVERGENCE_COMPOUND_SIGNALS.get(m))
        .filter((label): label is string => label !== undefined),
    ),
  ];
  const critical = divergence.some((a) => a.severity === AnomalySeverity.CRITICAL);
  if (!critical && signals.length === 0) return fallback;
  const context = signals.length > 0 ? ` alongside ${signals.join(', ')}` : '';
  return (
    `Sustained replication divergence${context} — the replica is not keeping up, ` +
    'and the pressures can compound while client throughput and latency still look healthy'
  );
}

const scopeByConnection: CorrelationScopeResolver = (anomaly) => anomaly.connectionId ?? '';

export class Correlator {
  private readonly correlationWindowMs: number;
  private readonly patternRules: PatternRule[];
  private readonly scopeOf: CorrelationScopeResolver;

  constructor(
    correlationWindowMs: number = 5000,
    scopeOf: CorrelationScopeResolver = scopeByConnection,
  ) {
    this.correlationWindowMs = correlationWindowMs;
    this.scopeOf = scopeOf;
    this.patternRules = this.initializePatternRules();
  }

  private initializePatternRules(): PatternRule[] {
    return [
      {
        pattern: AnomalyPattern.REPLICATION_DIVERGENCE,
        requiredMetrics: [MetricType.REPLICATION_DIVERGENCE],
        check: (anomalies) => !anomalies.some((a) => DIVERGENCE_YIELDS_TO.has(a.metricType)),
        diagnosis: 'Replica falling behind the primary — watching whether it catches up',
        recommendations: [
          'Compare the replica offset gap with the primary write rate over the next few minutes',
          'Check replica host CPU, disk and network for a slow apply path',
          'Review client-output-buffer-limit replica and repl-backlog-size against the write rate',
          'If bulk writes or resharding are driving it, throttle them until the replica catches up',
        ],
      },
      // Before failover so a window holding the saturation marker plus its side
      // effects (failover, cluster-state) resolves to saturation, not NODE_FAILOVER.
      {
        pattern: AnomalyPattern.CONTROL_PLANE_SATURATION,
        requiredMetrics: [MetricType.CPU_UTILIZATION],
        check: (anomalies) => {
          return anomalies.some((a) => {
            return isControlPlaneSaturationEvent(a);
          });
        },
        diagnosis:
          'Engine near CPU saturation with control-plane impact (replica drops / node timeouts / ' +
          'slow admin commands) — cluster stability at risk (valkey#3927)',
        recommendations: [
          'Shed load or isolate expensive queries (range scans, large-object serialization, heavy Lua)',
          'Check replica connection stability and cluster heartbeat health',
          'Keep a management path available: connect over a unix socket or reserved port for admin commands',
          'Upgrade to a QoS-capable version once the upstream trusted-sources feature (valkey#3927) lands',
        ],
      },
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
        pattern: AnomalyPattern.NODE_FAILOVER,
        requiredMetrics: [MetricType.REPLICATION_ROLE],
        optionalMetrics: [
          MetricType.SLOWLOG_LAST_ID,
          MetricType.CLUSTER_STATE,
          MetricType.OPS_PER_SEC,
        ],
        check: (anomalies) => {
          return anomalies.some((a) => a.metricType === MetricType.REPLICATION_ROLE);
        },
        get diagnosis() {
          return 'Node failover detected — this instance transitioned role';
        },
        recommendations: [
          'Verify the new primary is healthy and accepting writes',
          'Check replication lag on the new primary',
          'Review application connection strings for failover handling',
          'Inspect cluster logs for the cause of the failover',
          'Confirm no split-brain scenario exists',
        ],
      },
      {
        pattern: AnomalyPattern.NODE_FAILOVER,
        requiredMetrics: [MetricType.CLUSTER_STATE],
        diagnosis: 'Cluster state transition detected — slot coverage changed',
        recommendations: [
          'Check cluster slot coverage and reassign if needed',
          'Verify all master nodes are healthy and reachable',
          'Review cluster-level slow queries across nodes',
          'Inspect CLUSTER INFO for partially-failed slots',
          'Confirm no split-brain scenario exists',
        ],
      },
      {
        pattern: AnomalyPattern.RESHARD_PRESSURE,
        requiredMetrics: [MetricType.RESHARD_SHARD_SKEW],
        optionalMetrics: [
          MetricType.COMMAND_P99,
          MetricType.LOAD_SATURATION,
          MetricType.CPU_UTILIZATION,
          MetricType.MEMORY_USED,
          MetricType.OPS_PER_SEC,
        ],
        diagnosis:
          'Slot migration is concentrating load on one shard while the cluster aggregate looks healthy',
        recommendations: [
          'Pause or slow the reshard until the skewed shard recovers',
          'Reduce the keys moved per batch, or schedule the migration for a lower write period',
          'Check the source and target shards for slow commands and large keys in the moving slots',
          'Rebalance slots once the migration finishes if the skew remains',
        ],
      },
      {
        pattern: AnomalyPattern.PERSISTENCE_STALL,
        requiredMetrics: [MetricType.PERSISTENCE_CHILD],
        diagnosis:
          'Persistence fork child not advancing — BGSAVE/AOF-rewrite may be stuck or failing',
        recommendations: [
          'Check memory headroom and copy-on-write growth (current_cow_size)',
          'Inspect the server log for fork or allocator errors',
          'Consider BGSAVE CANCEL if the save is wedged',
          'Verify disk space and I/O on the persistence target',
        ],
      },
      {
        pattern: AnomalyPattern.SLOW_QUERIES,
        requiredMetrics: [MetricType.SLOWLOG_LAST_ID],
        diagnosis:
          'Slow query rate spike detected — elevated rate of new slow queries per interval',
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
          const hasMemorySpike = anomalies.some(
            (a) => a.metricType === MetricType.MEMORY_USED && a.anomalyType === AnomalyType.SPIKE,
          );
          const hasEvictions = anomalies.some((a) => a.metricType === MetricType.EVICTED_KEYS);
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
          const connAnomaly = anomalies.find((a) => a.metricType === MetricType.CONNECTIONS);
          if (!connAnomaly || connAnomaly.anomalyType !== AnomalyType.SPIKE) return false;

          // Connection leak: connections spike but ops remain stable
          const hasOpsAnomaly = anomalies.some((a) => a.metricType === MetricType.OPS_PER_SEC);
          return !hasOpsAnomaly;
        },
        diagnosis:
          'Potential connection leak: connections increasing without corresponding traffic',
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
          const hasConnSpike = anomalies.some(
            (a) => a.metricType === MetricType.CONNECTIONS && a.anomalyType === AnomalyType.SPIKE,
          );
          const hasOpsSpike = anomalies.some(
            (a) => a.metricType === MetricType.OPS_PER_SEC && a.anomalyType === AnomalyType.SPIKE,
          );
          const hasMemorySpike = anomalies.some(
            (a) => a.metricType === MetricType.MEMORY_USED && a.anomalyType === AnomalyType.SPIKE,
          );

          return hasConnSpike && hasOpsSpike && hasMemorySpike;
        },
        diagnosis:
          'Batch job or bulk operation detected with concurrent spikes in connections, operations, and memory',
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
          const hasConnSpike = anomalies.some(
            (a) => a.metricType === MetricType.CONNECTIONS && a.anomalyType === AnomalyType.SPIKE,
          );
          const hasOpsSpike = anomalies.some(
            (a) => a.metricType === MetricType.OPS_PER_SEC && a.anomalyType === AnomalyType.SPIKE,
          );

          // Traffic burst: connections and ops spike, but NOT memory
          const hasMemorySpike = anomalies.some(
            (a) => a.metricType === MetricType.MEMORY_USED && a.anomalyType === AnomalyType.SPIKE,
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
      // Single metric patterns - catch all individual anomalies
      {
        pattern: AnomalyPattern.TRAFFIC_BURST,
        requiredMetrics: [MetricType.OPS_PER_SEC],
        diagnosis: 'High operations spike detected',
        recommendations: [
          'Review command patterns in slow log and audit trail',
          'Check for batch operations or bulk imports',
          'Monitor client activity for unusual patterns',
          'Consider if this is expected traffic or an anomaly',
        ],
      },
      {
        pattern: AnomalyPattern.TRAFFIC_BURST,
        requiredMetrics: [MetricType.INPUT_KBPS],
        diagnosis: 'High input traffic detected',
        recommendations: [
          'Check for large data imports or writes',
          'Review client write patterns',
          'Monitor network bandwidth utilization',
          'Verify this matches expected application behavior',
        ],
      },
      {
        pattern: AnomalyPattern.TRAFFIC_BURST,
        requiredMetrics: [MetricType.OUTPUT_KBPS],
        diagnosis: 'High output traffic detected',
        recommendations: [
          'Check for large data exports or reads',
          'Review client read patterns',
          'Monitor network bandwidth utilization',
          'Consider implementing result pagination if needed',
        ],
      },
      {
        pattern: AnomalyPattern.MEMORY_PRESSURE,
        requiredMetrics: [MetricType.FRAGMENTATION_RATIO],
        diagnosis: 'Memory fragmentation spike detected',
        recommendations: [
          'Monitor memory fragmentation trends over time',
          'Consider running MEMORY PURGE if fragmentation persists',
          'Review allocation patterns that may cause fragmentation',
          'Plan for instance restart during maintenance window if needed',
        ],
      },
      {
        pattern: AnomalyPattern.MEMORY_PRESSURE,
        requiredMetrics: [MetricType.EVICTED_KEYS],
        diagnosis: 'Key eviction spike detected',
        recommendations: [
          'Check if maxmemory limit is being reached',
          'Review eviction policy (volatile-lru, allkeys-lru, etc.)',
          'Identify which keys are being evicted',
          'Consider increasing memory or optimizing data retention',
        ],
      },
      {
        pattern: AnomalyPattern.CONNECTION_LEAK,
        requiredMetrics: [MetricType.CONNECTIONS],
        diagnosis: 'Connection count spike detected',
        recommendations: [
          'Review client connection patterns',
          'Check for connection pool exhaustion',
          'Monitor idle connections',
          'Verify connection cleanup in client applications',
        ],
      },
      {
        pattern: AnomalyPattern.SLOW_QUERIES,
        requiredMetrics: [MetricType.BLOCKED_CLIENTS],
        diagnosis: 'Blocked clients detected',
        recommendations: [
          'Check for blocking operations (BLPOP, BRPOP, etc.)',
          'Review command execution times',
          'Monitor for potential deadlocks',
          'Consider timeout configurations',
        ],
      },
      {
        pattern: AnomalyPattern.SLOW_QUERIES,
        requiredMetrics: [MetricType.COMMAND_P99],
        diagnosis: 'Per-command P99 latency regression detected',
        recommendations: [
          'Compare per-command P99 before and after the regression in latencystats history',
          'Check for a recent server upgrade or config change on this instance',
          'Look for concurrent resharding, resync or persistence activity',
          'Review the commands named in the regression for larger payloads',
        ],
      },
      {
        pattern: AnomalyPattern.CACHE_THRASHING,
        requiredMetrics: [MetricType.KEYSPACE_MISSES],
        diagnosis: 'High cache miss rate detected',
        recommendations: [
          'Review cache hit ratio trends',
          'Check if working set has changed',
          'Analyze access patterns for optimization',
          'Consider cache warming strategies',
        ],
      },
    ];
  }

  correlate(anomalies: AnomalyEvent[]): CorrelatedAnomalyGroup[] {
    if (anomalies.length === 0) return [];

    // Sort by timestamp
    const sorted = [...anomalies].sort((a, b) => a.timestamp - b.timestamp);

    // Partition by topology scope first so unrelated instances alerting in the
    // same few seconds never share a group; nodes of one cluster still do.
    const partitions = new Map<string, AnomalyEvent[]>();
    for (const anomaly of sorted) {
      const scope = this.scopeOf(anomaly);
      const partition = partitions.get(scope);
      if (partition) {
        partition.push(anomaly);
      } else {
        partitions.set(scope, [anomaly]);
      }
    }

    const windows = [...partitions.values()]
      .flatMap((partition) => this.splitIntoWindows(partition))
      .sort((a, b) => a[0].timestamp - b[0].timestamp);

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
          groups.push(
            this.createGroup(windowAnomalies, {
              pattern: AnomalyPattern.UNKNOWN,
              requiredMetrics: [],
              diagnosis: `${windowAnomalies[0].metricType} anomaly detected`,
              recommendations: [
                'Investigate the specific metric trend',
                'Check for related system events',
              ],
            }),
          );
        }
      } else {
        // Multiple anomalies - detect pattern
        const pattern = this.detectPattern(windowAnomalies);
        if (pattern) {
          groups.push(this.createGroup(windowAnomalies, pattern));
        } else {
          // Multiple anomalies but no specific pattern match
          groups.push(
            this.createGroup(windowAnomalies, {
              pattern: AnomalyPattern.UNKNOWN,
              requiredMetrics: [],
              diagnosis: `Multiple concurrent anomalies detected: ${windowAnomalies.map((a) => a.metricType).join(', ')}`,
              recommendations: [
                'Investigate correlation between affected metrics',
                'Check for external system events or changes',
                'Review application behavior during this time',
              ],
            }),
          );
        }
      }
    }

    return groups;
  }

  private splitIntoWindows(sorted: AnomalyEvent[]): AnomalyEvent[][] {
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

    return windows;
  }

  private detectPattern(anomalies: AnomalyEvent[]): PatternRule | null {
    const metricTypes = new Set(anomalies.map((a) => a.metricType));

    // Check each pattern rule
    for (const rule of this.patternRules) {
      // Check if all required metrics are present
      const hasAllRequired = rule.requiredMetrics.every((m) => metricTypes.has(m));
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
    anomalies.forEach((a) => {
      a.correlationId = correlationId;
      const members = anomalies
        .filter((other) => other.id !== a.id)
        .map((other) => other.metricType);
      a.relatedMetrics = [...new Set([...(a.relatedMetrics ?? []), ...members])];
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
      timestamp: Math.min(...anomalies.map((a) => a.timestamp)),
      anomalies,
      pattern: rule.pattern,
      diagnosis: this.enrichDiagnosis(rule, anomalies),
      recommendations: rule.recommendations,
      severity: maxSeverity,
    };
  }

  /**
   * Enrich diagnosis text with context from co-occurring anomalies.
   * For NODE_FAILOVER, dynamically mention slowlog correlation if present.
   */
  private enrichDiagnosis(rule: PatternRule, anomalies: AnomalyEvent[]): string {
    if (rule.pattern === AnomalyPattern.REPLICATION_DIVERGENCE) {
      return describeReplicationDivergence(rule.diagnosis, anomalies);
    }

    if (rule.pattern === AnomalyPattern.NODE_FAILOVER) {
      const hasSlowlogSpike = anomalies.some((a) => a.metricType === MetricType.SLOWLOG_LAST_ID);
      const hasClusterState = anomalies.some((a) => a.metricType === MetricType.CLUSTER_STATE);
      const hasRoleChange = anomalies.some((a) => a.metricType === MetricType.REPLICATION_ROLE);

      let diagnosis = rule.diagnosis;

      if (hasRoleChange && hasSlowlogSpike) {
        diagnosis =
          'Node failover detected with correlated slowlog spike — the slow queries are likely caused by the failover transition';
      } else if (hasClusterState && hasSlowlogSpike) {
        diagnosis =
          'Cluster state transition detected with correlated slowlog spike — slot re-coverage may have caused latency';
      }

      return diagnosis;
    }

    return rule.diagnosis;
  }

  getPatternDescription(pattern: AnomalyPattern): string {
    const rule = this.patternRules.find((r) => r.pattern === pattern);
    return rule?.diagnosis || 'Unknown pattern';
  }

  getPatternRecommendations(pattern: AnomalyPattern): string[] {
    const rule = this.patternRules.find((r) => r.pattern === pattern);
    return rule?.recommendations || [];
  }
}
