import {
  RAISE_REPL_BACKLOG_RECOMMENDATION,
  RESYNC_ESCALATION_WINDOW_MS,
} from './recovery-amplification-detector';
import { registerSequenceRule } from './sequence-rules';
import { AnomalyPattern, MetricType } from './types';

const MIN = 60_000;

export const DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS = 15 * MIN;
export const RESHARD_UNDER_WRITES_MAX_SPAN_MS = 15 * MIN;
export const RETRY_STORM_MAX_SPAN_MS = 10 * MIN;
export const BACKLOG_EXHAUSTION_MAX_SPAN_MS = 30 * MIN;

registerSequenceRule({
  pattern: AnomalyPattern.DIVERGENCE_UNDER_PRESSURE,
  steps: [
    [MetricType.OPS_PER_SEC, MetricType.INPUT_KBPS],
    [MetricType.REPLICATION_DIVERGENCE],
    [MetricType.MEMORY_USED, MetricType.MEMORY_OVERHEAD, MetricType.REPL_BUFFER_PRESSURE],
  ],
  optionalMetrics: [MetricType.EVICTED_KEYS, MetricType.EVICTED_CLIENTS, MetricType.FORK_MEMORY_RISK],
  maxSpanMs: DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS,
  leadMs: { 2: DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS },
  sameConnection: true,
  diagnosis:
    'A write-rate rise outpaced replication, the replicas fell behind, and the primary took the memory cost of holding the unshipped writes.',
  recommendations: [
    'Find the client or job behind the write rise and throttle or batch it',
    'Check replica network and CPU headroom so they can apply writes at the new rate',
    'Raise client-output-buffer-limit for replicas or add memory headroom before evictions start',
  ],
});

registerSequenceRule({
  pattern: AnomalyPattern.RESHARD_UNDER_WRITES,
  steps: [[MetricType.RESHARD_SHARD_SKEW], [MetricType.REPLICATION_DIVERGENCE]],
  optionalMetrics: [MetricType.COMMAND_P99],
  maxSpanMs: RESHARD_UNDER_WRITES_MAX_SPAN_MS,
  diagnosis:
    'During a reshard one shard carried far more traffic, CPU, memory or write latency than the rest, and replicas then fell behind the stream.',
  recommendations: [
    'Check which measure the shard skew alert names before acting on it',
    'Slow the slot migration or move slots in smaller batches while the skewed shard is loaded',
    'Watch replica lag on the skewed shards until it settles',
  ],
});

registerSequenceRule({
  pattern: AnomalyPattern.RETRY_STORM,
  steps: [
    [MetricType.COMMAND_P99, MetricType.ERROR_REPLIES],
    [MetricType.RETRY_AMPLIFICATION],
    [
      MetricType.CLIENT_SATURATION,
      MetricType.LOAD_SATURATION,
      MetricType.REJECTED_CONNECTIONS,
      MetricType.CLIENT_LOCKOUT_RISK,
    ],
  ],
  optionalMetrics: [MetricType.CONNECTION_CHURN],
  maxSpanMs: RETRY_STORM_MAX_SPAN_MS,
  leadMs: { 2: RETRY_STORM_MAX_SPAN_MS },
  sameConnection: true,
  diagnosis:
    'Slow or failing commands made clients retry while the server was out of client or processing headroom, and the retries multiplied the load.',
  recommendations: [
    'Add backoff with jitter and a retry budget to the clients',
    'Fix the slow or failing commands that started the retries',
    'Raise maxclients or shed load until the retry traffic drains',
  ],
});

registerSequenceRule({
  pattern: AnomalyPattern.BACKLOG_EXHAUSTION,
  steps: [[MetricType.BACKLOG_COVERAGE_RISK], [MetricType.RESYNC_ESCALATION]],
  maxSpanMs: BACKLOG_EXHAUSTION_MAX_SPAN_MS,
  leadMs: { 1: RESYNC_ESCALATION_WINDOW_MS },
  sameConnection: true,
  diagnosis:
    'The replication backlog had shrunk below the time a replica needs to reconnect, and a later disconnect outran it and forced a full resync.',
  recommendations: [
    RAISE_REPL_BACKLOG_RECOMMENDATION,
    'Check why the replica disconnected',
    'Act on backlog coverage warnings before a disconnect turns them into a full resync',
  ],
});
