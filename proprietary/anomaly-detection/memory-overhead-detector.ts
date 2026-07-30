/**
 * Non-dataset memory overhead detection (valkey-io/valkey#1792, refined memory
 * management): a maxmemory budget is meant to bound the DATASET, but the server
 * also spends memory on non-dataset overhead — client output buffers, the
 * replication backlog and per-replica buffers, the AOF rewrite buffer,
 * scripts/functions, and cluster-bus links. That operational overhead is
 * charged against the SAME maxmemory budget, so when it grows it silently
 * shrinks the room left for user data and, under an eviction policy, actively
 * drives eviction of keys that would otherwise fit. This module surfaces when
 * operational overhead is consuming a large share of maxmemory and/or is the
 * force squeezing user data out.
 *
 * Operational overhead is `used_memory_overhead - used_memory_startup`: the
 * total overhead minus the fixed startup baseline (empty-server allocations
 * that exist regardless of load and are not actionable), leaving the
 * load-driven, tunable part.
 *
 * The evaluator is re-entrant on an external per-connection state object (the
 * anomaly service holds one per connection) and follows the client-saturation
 * hysteresis contract: emitted on escalation only (never every poll while
 * steady), kept pending until the caller acknowledges a successful emit (so a
 * failed emit retries next poll), and re-armed (ackedLevel lowered) when
 * overhead drops back to a lower band.
 */

/** Operational overhead at/above this fraction of maxmemory is a WARNING. */
export const OVERHEAD_WARN_FRACTION = 0.3;
/**
 * Operational overhead at/above this fraction of maxmemory is a CRITICAL:
 * half the eviction budget is being spent on non-dataset memory, so at most
 * half remains for user data.
 */
export const OVERHEAD_CRIT_FRACTION = 0.5;
/**
 * Eviction-driven CRITICAL floor. When keys are actively being evicted under an
 * eviction policy AND operational overhead has grown LARGER THAN THE USER
 * DATASET ITSELF, overhead — not the data — is the dominant consumer driving
 * eviction: a CRITICAL even below OVERHEAD_CRIT_FRACTION, but only once overhead
 * is at least a non-trivial share of the budget (the WARN floor). Comparing
 * against the dataset (not the near-zero "remaining budget" of a full cache) is
 * what keeps a normal capacity-bound LRU cache — large dataset, small overhead,
 * evicting every poll by design — from reading as a CRITICAL.
 */
export const EVICTION_OVERHEAD_MIN_FRACTION = OVERHEAD_WARN_FRACTION;

export interface OverheadComponents {
  clientsNormal: number;
  clientsSlaves: number;
  replBacklog: number;
  replBuffers: number;
  aofBuffer: number;
  scriptsFunctions: number;
  clusterLinks: number;
}

export interface MemoryOverheadInput {
  usedMemory: number;
  usedMemoryOverhead: number;
  usedMemoryStartup: number;
  usedMemoryDataset: number;
  maxmemory: number;
  maxmemoryPolicy: string;
  components: OverheadComponents;
  /** evicted_keys increments since the previous poll (service-computed, >= 0). */
  evictedKeysDelta: number;
  timestamp: number;
}

export type OverheadLevel = 'none' | 'warning' | 'critical';

export interface MemoryOverheadState {
  ackedLevel: OverheadLevel;
}

export interface MemoryOverheadFinding {
  level: 'warning' | 'critical';
  overheadBytes: number;
  overheadFraction: number;
  dominantComponent: string;
  message: string;
  timestamp: number;
}

const LEVEL_RANK: Record<OverheadLevel, number> = { none: 0, warning: 1, critical: 2 };

/** Human labels for the dominant overhead component, keyed to OverheadComponents. */
const COMPONENT_LABELS: Record<keyof OverheadComponents, string> = {
  clientsNormal: 'normal client output buffers',
  clientsSlaves: 'replica client output buffers',
  replBacklog: 'replication backlog',
  replBuffers: 'replication buffers',
  aofBuffer: 'AOF buffer',
  scriptsFunctions: 'scripts/functions',
  clusterLinks: 'cluster links',
};

/** Remediation hint keyed by the dominant component, so advice is actionable. */
const COMPONENT_REMEDY: Record<keyof OverheadComponents, string> = {
  clientsNormal: 'tune client-output-buffer-limit normal or shed slow/idle clients',
  clientsSlaves: 'tune client-output-buffer-limit slave or reduce the write burst to replicas',
  replBacklog: 'lower repl-backlog-size',
  replBuffers: 'lower repl-backlog-size or reduce the replication write burst',
  aofBuffer: 'investigate a stalled AOF rewrite / slow disk flushing the AOF buffer',
  scriptsFunctions: 'reduce the number/size of cached scripts (SCRIPT FLUSH) or functions',
  clusterLinks: 'investigate cluster-bus link buffering (large cluster / unstable links)',
};

export function createMemoryOverheadState(): MemoryOverheadState {
  return { ackedLevel: 'none' };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))}B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)}KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${Math.round(mb)}MB`;
  }
  return `${(mb / 1024).toFixed(1)}GB`;
}

/**
 * Largest single overhead component, with its byte size (for the message).
 * Returns `key: null` when the per-component `mem_*` breakdown is unavailable
 * (every component parsed to 0) — so a high-overhead alert on a server that
 * doesn't expose the breakdown doesn't falsely blame the first component.
 */
function dominantComponent(components: OverheadComponents): {
  key: keyof OverheadComponents | null;
  bytes: number;
} {
  const keys = Object.keys(components) as Array<keyof OverheadComponents>;
  let bestKey: keyof OverheadComponents = keys[0];
  let bestBytes = components[bestKey];
  for (const key of keys) {
    if (components[key] > bestBytes) {
      bestKey = key;
      bestBytes = components[key];
    }
  }
  if (bestBytes <= 0) {
    return { key: null, bytes: 0 };
  }
  return { key: bestKey, bytes: bestBytes };
}

/**
 * Folds one poll into the connection state and returns a finding to emit, or
 * null. Mutates `state` (re-arms ackedLevel on a drop). The returned finding
 * keeps being produced every poll until `acknowledgeMemoryOverheadFinding` is
 * called, so a failed emit retries next poll.
 */
export function evaluateMemoryOverhead(
  state: MemoryOverheadState,
  input: MemoryOverheadInput,
): MemoryOverheadFinding | null {
  // No eviction budget → maxmemory fraction is meaningless and there is no
  // budget for overhead to squeeze. Nothing to say.
  if (input.maxmemory <= 0) {
    return null;
  }

  const operationalOverhead = Math.max(0, input.usedMemoryOverhead - input.usedMemoryStartup);
  const overheadFraction = operationalOverhead / input.maxmemory;

  // Overhead outgrowing the user dataset ITSELF, while eviction is active, is
  // the signature of overhead (not data growth) driving eviction. Comparing
  // against the dataset — rather than the near-zero "remaining budget" of a
  // capacity-bound cache — is what stops a normal full LRU cache (large dataset,
  // small overhead, evicting every poll by design) from reading as a CRITICAL.
  const evictionActive =
    input.maxmemoryPolicy !== 'noeviction' && input.evictedKeysDelta > 0;
  const overheadSqueezingData =
    evictionActive &&
    overheadFraction >= EVICTION_OVERHEAD_MIN_FRACTION &&
    operationalOverhead > input.usedMemoryDataset;

  let level: OverheadLevel = 'none';
  if (overheadFraction >= OVERHEAD_CRIT_FRACTION || overheadSqueezingData) {
    level = 'critical';
  } else if (overheadFraction >= OVERHEAD_WARN_FRACTION) {
    level = 'warning';
  }

  // Re-arm on a drop to a lower band, exactly as cob-pressure/client-saturation
  // do — so a later escalation alerts again.
  if (LEVEL_RANK[level] < LEVEL_RANK[state.ackedLevel]) {
    state.ackedLevel = level;
  }

  // Escalation-only: emit only when the current level is above what's acked.
  if (LEVEL_RANK[level] <= LEVEL_RANK[state.ackedLevel] || level === 'none') {
    return null;
  }

  const dominant = dominantComponent(input.components);
  const pct = (overheadFraction * 100).toFixed(1);
  const isCritical = level === 'critical';

  // When the per-component breakdown is unavailable, name no component and point
  // the operator at the breakdown itself rather than at an arbitrary knob.
  const dominantClause =
    dominant.key !== null
      ? `, dominated by ${COMPONENT_LABELS[dominant.key]} (${formatBytes(dominant.bytes)})`
      : ' (per-component mem_* breakdown unavailable)';
  const remedy =
    dominant.key !== null
      ? COMPONENT_REMEDY[dominant.key]
      : 'inspect the INFO memory mem_* fields to find the dominant consumer';

  const squeezeClause = overheadSqueezingData
    ? ` Eviction is active (${input.evictedKeysDelta} keys evicted since last poll under ` +
      `maxmemory-policy ${input.maxmemoryPolicy}) and overhead (${formatBytes(operationalOverhead)}) ` +
      `now exceeds the user dataset itself (${formatBytes(Math.max(0, input.usedMemoryDataset))}) — ` +
      `non-dataset memory is the dominant consumer driving eviction.`
    : '';

  const message =
    `${isCritical ? 'CRITICAL' : 'WARNING'}: Non-dataset memory overhead is ` +
    `${formatBytes(operationalOverhead)} (${pct}% of maxmemory ${formatBytes(input.maxmemory)})` +
    `${dominantClause}. This overhead is charged against the maxmemory budget, leaving less room ` +
    `for user data (valkey#1792).${squeezeClause} Remediation: ${remedy}, or raise maxmemory.`;

  return {
    level,
    overheadBytes: operationalOverhead,
    overheadFraction,
    dominantComponent: dominant.key ?? 'unknown',
    message,
    timestamp: input.timestamp,
  };
}

/**
 * Advances the stored hysteresis level after a finding was successfully
 * emitted, so a steady condition alerts once (not every poll). A failed emit
 * (caller doesn't acknowledge) leaves ackedLevel unchanged, so the next poll
 * re-produces the finding.
 */
export function acknowledgeMemoryOverheadFinding(
  state: MemoryOverheadState,
  finding: MemoryOverheadFinding,
): void {
  state.ackedLevel = finding.level;
}
