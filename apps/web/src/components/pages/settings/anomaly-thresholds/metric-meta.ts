import { ANOMALY_DETECTOR_METRICS, type AnomalyDetectorMetric } from '@betterdb/shared';

interface MetricMeta {
  label: string;
  description: string;
  absoluteUnit: string;
}

// Record<AnomalyDetectorMetric, …> makes the build fail if a metric is added to
// ANOMALY_DETECTOR_METRICS without UI metadata.
// Only slowlog_last_id is fed to its detector as a per-poll delta; acl_denied,
// evicted_keys and keyspace_misses are fed the raw lifetime counters.
export const METRIC_META: Record<AnomalyDetectorMetric, MetricMeta> = {
  connections: { label: 'Connections', description: 'Connected clients', absoluteUnit: 'clients' },
  ops_per_sec: {
    label: 'Ops/sec',
    description: 'Instantaneous operations per second',
    absoluteUnit: 'ops/s',
  },
  memory_used: { label: 'Memory used', description: 'Allocated memory', absoluteUnit: 'bytes' },
  input_kbps: { label: 'Input KB/s', description: 'Network input', absoluteUnit: 'KB/s' },
  output_kbps: { label: 'Output KB/s', description: 'Network output', absoluteUnit: 'KB/s' },
  slowlog_last_id: {
    label: 'Slow queries',
    description: 'New slowlog entries per poll',
    absoluteUnit: 'entries/poll',
  },
  acl_denied: {
    label: 'ACL denials',
    description: 'ACL auth denials (cumulative counter)',
    absoluteUnit: 'denials',
  },
  evicted_keys: {
    label: 'Evicted keys',
    description: 'Keys evicted (cumulative counter)',
    absoluteUnit: 'keys',
  },
  blocked_clients: {
    label: 'Blocked clients',
    description: 'Clients blocked on BLPOP/BRPOP etc.',
    absoluteUnit: 'clients',
  },
  keyspace_misses: {
    label: 'Keyspace misses',
    description: 'Failed key lookups (cumulative counter)',
    absoluteUnit: 'misses',
  },
  fragmentation_ratio: {
    label: 'Fragmentation',
    description: 'Allocator fragmentation ratio',
    absoluteUnit: 'ratio',
  },
};

/** Display order is the shared order; there is no second list to keep in sync. */
export const METRIC_ORDER: readonly AnomalyDetectorMetric[] = ANOMALY_DETECTOR_METRICS;
