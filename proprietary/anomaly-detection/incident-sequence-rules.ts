import {
  RAISE_REPL_BACKLOG_RECOMMENDATION,
  RESYNC_ESCALATION_WINDOW_MS,
} from './recovery-amplification-detector';
import { registerSequenceRule } from './sequence-rules';
import { AnomalyPattern, AnomalySeverity, MetricType } from './types';

const MIN = 60_000;

export const DIVERGENCE_UNDER_PRESSURE_MAX_SPAN_MS = 15 * MIN;
export const RESHARD_UNDER_WRITES_MAX_SPAN_MS = 15 * MIN;
export const RESHARD_DIVERGENCE_PRESSURE_MAX_SPAN_MS = 15 * MIN;
export const RETRY_STORM_MAX_SPAN_MS = 10 * MIN;
export const BACKLOG_EXHAUSTION_MAX_SPAN_MS = 30 * MIN;
export const SPLIT_BRAIN_MAX_SPAN_MS = 15 * MIN;
export const SPLIT_BRAIN_TOPOLOGY_LEAD_MS = 2 * MIN;
export const HOT_SHARD_LATENCY_MAX_SPAN_MS = 15 * MIN;
export const HOT_SHARD_LATENCY_LEAD_MS = 10 * MIN;
export const MIGRATION_REDIRECTS_MAX_SPAN_MS = 15 * MIN;
export const MEMBERSHIP_FAILOVER_MAX_SPAN_MS = 30 * MIN;

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

registerSequenceRule({
  pattern: AnomalyPattern.SPLIT_BRAIN,
  steps: [
    [MetricType.TOPOLOGY_DIVERGENCE, MetricType.PARTIAL_MEMBERSHIP],
    [MetricType.CLUSTER_TOPOLOGY],
  ],
  optionalMetrics: [MetricType.REPLICATION_ROLE, MetricType.FAILOVER_CHURN, MetricType.ERROR_REPLIES],
  directions: { [MetricType.ERROR_REPLIES]: 'rise' },
  // A stuck replica is also a cluster_topology event, as a warning. A duplicate primary is critical.
  minSeverity: { [MetricType.CLUSTER_TOPOLOGY]: AnomalySeverity.CRITICAL },
  maxSpanMs: SPLIT_BRAIN_MAX_SPAN_MS,
  // A duplicate primary is raised on the first poll that sees it, a disagreement only once confirmed.
  leadMs: { 1: SPLIT_BRAIN_TOPOLOGY_LEAD_MS },
  // The two rules give opposite CLUSTER FORGET advice, so one incident never lists both.
  supersedesInIncident: [AnomalyPattern.MEMBERSHIP_FAILOVER],
  diagnosis:
    'Nodes disagreed on who is in the cluster, and two primaries claimed the same slots. ' +
    'Writes accepted by the primary that loses will be dropped when the cluster converges.',
  recommendations: [
    'Check the network between the nodes on each side of the disagreement before you touch the cluster',
    'Compare the configEpoch of the two primaries: the lower one is the stale side',
    'Stop writes to the stale primary or fail it over by hand; do not run CLUSTER FORGET until both sides agree',
  ],
});

registerSequenceRule({
  pattern: AnomalyPattern.HOT_SHARD_LATENCY,
  steps: [[MetricType.HOT_SHARD], [MetricType.COMMAND_P99, MetricType.RETRY_AMPLIFICATION]],
  optionalMetrics: [MetricType.ERROR_REPLIES, MetricType.CLIENT_SATURATION],
  directions: { [MetricType.COMMAND_P99]: 'rise', [MetricType.ERROR_REPLIES]: 'rise' },
  maxSpanMs: HOT_SHARD_LATENCY_MAX_SPAN_MS,
  leadMs: { 1: HOT_SHARD_LATENCY_LEAD_MS },
  diagnosis: 'One shard carried far more load than the others, and tail latency rose with it.',
  recommendations: [
    'Open the hot shard and review the suggested slot rebalance',
    'If the load sits on a few keys, move it in the application: a slot move will not help',
    'Watch the P99 after the move; the hot shard event closes when the load evens out',
  ],
});

registerSequenceRule({
  pattern: AnomalyPattern.MIGRATION_REDIRECTS,
  steps: [
    [MetricType.SLOT_MIGRATION, MetricType.SLOT_MIGRATION_STUCK],
    [MetricType.ERROR_REPLIES, MetricType.COMMAND_P99],
  ],
  optionalMetrics: [MetricType.RETRY_AMPLIFICATION],
  directions: { [MetricType.ERROR_REPLIES]: 'rise', [MetricType.COMMAND_P99]: 'rise' },
  maxSpanMs: MIGRATION_REDIRECTS_MAX_SPAN_MS,
  diagnosis:
    'A slot migration was running when errors or tail latency rose: clients are being redirected (ASK, TRYAGAIN) or waiting on keys being moved.',
  recommendations: [
    'Check that clients follow ASK redirects and retry TRYAGAIN with backoff',
    'Move slots in smaller batches, or pause the migration until traffic is lower',
    'If the migration is stuck, follow the steps in its alert; a rebalance run started from the Anomalies page can be cancelled there',
  ],
});

registerSequenceRule({
  pattern: AnomalyPattern.MEMBERSHIP_FAILOVER,
  steps: [
    [MetricType.PARTIAL_MEMBERSHIP, MetricType.GHOST_MEMBERSHIP],
    [MetricType.FAILOVER_CHURN],
  ],
  optionalMetrics: [MetricType.TOPOLOGY_DIVERGENCE],
  maxSpanMs: MEMBERSHIP_FAILOVER_MAX_SPAN_MS,
  diagnosis:
    'A node that only part of the cluster knows about, or that should be gone, was followed by repeated failovers.',
  recommendations: [
    'Find the node named in the membership event and confirm whether it should be in the cluster',
    'Remove a node that should be gone with CLUSTER FORGET on every node, within 60 seconds',
    'Check cluster-node-timeout is the same on every node',
  ],
});
