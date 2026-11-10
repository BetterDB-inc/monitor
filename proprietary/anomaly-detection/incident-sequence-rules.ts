import {
  RAISE_REPL_BACKLOG_RECOMMENDATION,
  RESYNC_ESCALATION_WINDOW_MS,
} from './recovery-amplification-detector';
import { registerSequenceRule } from './sequence-rules';
import { AnomalyPattern, MetricType } from './types';

const MIN = 60_000;

export const DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS = 15 * MIN;
export const RESHARD_UNDER_WRITES_MAX_SPAN_MS = 15 * MIN;
export const RESHARD_DIVERGENCE_PRESSURE_MAX_SPAN_MS = 15 * MIN;
export const RETRY_STORM_MAX_SPAN_MS = 10 * MIN;
export const BACKLOG_EXHAUSTION_MAX_SPAN_MS = 30 * MIN;

const MEMORY_PRESSURE = [MetricType.MEMORY_USED, MetricType.MEMORY_OVERHEAD, MetricType.REPL_BUFFER_PRESSURE];

registerSequenceRule({
  pattern: AnomalyPattern.DIVERGENCE_UNDER_PRESSURE,
  steps: [[MetricType.OPS_PER_SEC, MetricType.INPUT_KBPS], [MetricType.REPLICATION_DIVERGENCE], MEMORY_PRESSURE],
  optionalMetrics: [MetricType.EVICTED_KEYS, MetricType.EVICTED_CLIENTS, MetricType.FORK_MEMORY_RISK],
  directions: {
    [MetricType.OPS_PER_SEC]: 'rise',
    [MetricType.INPUT_KBPS]: 'rise',
    [MetricType.MEMORY_USED]: 'rise',
    [MetricType.EVICTED_KEYS]: 'rise',
    [MetricType.EVICTED_CLIENTS]: 'rise',
  },
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
  pattern: AnomalyPattern.RESHARD_DIVERGENCE_PRESSURE,
  steps: [[MetricType.RESHARD_SHARD_SKEW], [MetricType.REPLICATION_DIVERGENCE], MEMORY_PRESSURE],
  optionalMetrics: [
    MetricType.OPS_PER_SEC,
    MetricType.INPUT_KBPS,
    MetricType.COMMAND_P99,
    MetricType.EVICTED_KEYS,
    MetricType.EVICTED_CLIENTS,
    MetricType.FORK_MEMORY_RISK,
  ],
  directions: {
    [MetricType.OPS_PER_SEC]: 'rise',
    [MetricType.INPUT_KBPS]: 'rise',
    [MetricType.MEMORY_USED]: 'rise',
    [MetricType.EVICTED_KEYS]: 'rise',
    [MetricType.EVICTED_CLIENTS]: 'rise',
  },
  maxSpanMs: RESHARD_DIVERGENCE_PRESSURE_MAX_SPAN_MS,
  leadMs: { 2: RESHARD_DIVERGENCE_PRESSURE_MAX_SPAN_MS },
  sameConnection: true,
  supersedes: [AnomalyPattern.RESHARD_UNDER_WRITES, AnomalyPattern.DIVERGENCE_UNDER_PRESSURE],
  diagnosis:
    'A reshard loaded one shard, its replicas fell behind, and the primary ran short of memory or replica buffer room, each slowing the others\' recovery. ' +
    'Slot migration adds writes the lagging replicas must still apply. The writes they have not applied hold memory and buffer space on the primary. ' +
    'Memory pressure can make slot imports fail, which keeps the reshard running, and a full replica buffer drops the link and forces a resync that costs more memory and more lag.',
  recommendations: [
    'Pause the slot migration until replica lag and memory settle, then resume in smaller batches',
    'Raise client-output-buffer-limit for replicas or add memory headroom so the replica link is not dropped',
    'Check replica network and CPU headroom on the skewed shard so replicas can catch up',
  ],
});

registerSequenceRule({
  pattern: AnomalyPattern.RETRY_STORM,
  steps: [
    [MetricType.COMMAND_P99, MetricType.ERROR_REPLIES, MetricType.CONNECTION_CHURN],
    [MetricType.RETRY_AMPLIFICATION],
  ],
  optionalMetrics: [
    MetricType.CLIENT_SATURATION,
    MetricType.LOAD_SATURATION,
    MetricType.REJECTED_CONNECTIONS,
    MetricType.CLIENT_LOCKOUT_RISK,
  ],
  directions: {
    [MetricType.COMMAND_P99]: 'rise',
    [MetricType.ERROR_REPLIES]: 'rise',
    [MetricType.CONNECTION_CHURN]: 'rise',
  },
  maxSpanMs: RETRY_STORM_MAX_SPAN_MS,
  sameConnection: true,
  carriesFirstStep: (event) => event.retryTrigger === 'churn',
  diagnosis:
    'Slow commands, failing commands or a wave of reconnects made clients retry, and the retries multiplied the load. Saturation in the same window means the server had no headroom left to absorb them.',
  recommendations: [
    'Add backoff with jitter and a retry budget to the clients',
    'Fix the slow or failing commands, or the cause of the reconnects, that started the retries',
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
