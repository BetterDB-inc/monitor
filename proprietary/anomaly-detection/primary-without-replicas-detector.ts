import { parseReplicaLines } from '@app/database/parsers/replication-info.parser';

/**
 * Primary without replicas (BetterDB-inc/monitor#714): a primary whose shard
 * normally has replicas has had no synced replica for longer than a short
 * grace period. Until a replica is back in sync, the primary holds the only
 * copy of the shard's data. A Kubernetes operator roll that restarts both
 * replicas of a shard before either is back in sync produces exactly this.
 *
 * The evaluator works on one state object per shard. The anomaly service keys
 * that state by cluster and slot ranges, not by connection, so a failover or a
 * primary that comes back under a new address continues the same episode.
 *
 * A level is recorded on the state in the same call that returns its finding,
 * so two connections that observe one shard in the same poll cycle cannot both
 * raise it.
 */

/** Healthy polls in a row that end an episode. */
export const PRIMARY_NO_REPLICA_RESOLVE_POLLS = 2;

export interface PrimaryWithoutReplicasConfig {
  /** No synced replica for this long raises a WARNING. 0 turns the level off. */
  warnMs: number;
  /** No synced replica for this long raises a CRITICAL. 0 turns the level off. */
  critMs: number;
  /** How long a replica count stays expected after it was last seen. */
  expectationTtlMs: number;
}

export const DEFAULT_PRIMARY_WITHOUT_REPLICAS_CONFIG: PrimaryWithoutReplicasConfig = {
  warnMs: 5_000,
  critMs: 30_000,
  expectationTtlMs: 24 * 60 * 60_000,
};

export interface PrimaryReplicaInput {
  /** INFO `role`. */
  role: string;
  /** Cluster: whether the node's own CLUSTER NODES line has slots. Null on a standalone node. */
  ownsSlots: boolean | null;
  /** Name of the primary for the message, e.g. `10.0.0.1:6379 (90735665)`. */
  primary: string;
  /** Canonical slot ranges of the shard. Null on a standalone node. */
  slots: string | null;
  /** INFO `connected_slaves`. */
  attached: number;
  /** Replicas the primary reports as `state=online`. */
  synced: number;
  /** True only when persistence is known to be off. Null when it cannot be read. */
  persistenceOff: boolean | null;
  timestamp: number;
}

export interface ShardReplicaState {
  /** High-water mark of `connected_slaves`. 0 means the shard is not expected to have replicas. */
  expectedReplicas: number;
  expectedSeenAt: number;
  /** First poll of the current run with no synced replica. */
  zeroSince: number | null;
  healthyPolls: number;
  alerted: 'none' | 'warning' | 'critical';
  lastSeenAt: number;
}

export interface PrimaryWithoutReplicasFinding {
  severity: 'warning' | 'critical';
  attached: number;
  synced: number;
  expected: number;
  zeroForMs: number;
  persistenceOff: boolean | null;
  message: string;
}

const LEVEL_RANK = { none: 0, warning: 1, critical: 2 } as const;

export function createShardReplicaState(timestamp: number): ShardReplicaState {
  return {
    expectedReplicas: 0,
    expectedSeenAt: timestamp,
    zeroSince: null,
    healthyPolls: 0,
    alerted: 'none',
    lastSeenAt: timestamp,
  };
}

/** Replicas a primary's own INFO reports as in sync (`state=online`). */
export function syncedReplicaCount(info: Record<string, string>): number {
  return parseReplicaLines(info).filter((replica) => replica.state === 'online').length;
}

function buildMessage(input: PrimaryReplicaInput, expected: number, zeroForMs: number): string {
  const shard = input.slots ? ` for slots ${input.slots}` : '';
  const risk =
    input.persistenceOff === true
      ? 'Persistence is off, so losing this node now loses its data.'
      : 'Losing this node now loses every write not yet saved to disk.';
  return (
    `Primary ${input.primary}${shard} has had no synced replica for ${Math.round(zeroForMs / 1000)} s ` +
    `(${input.attached} attached, ${input.synced} synced, ${expected} expected). ${risk} ` +
    `If a rolling update is in progress, pause it until a replica reports master_link_status:up.`
  );
}

/**
 * Folds one observation of a shard's primary into its state. Mutates `state`.
 * Returns a finding the first time an episode reaches WARNING and the first
 * time it reaches CRITICAL, and null otherwise. The episode is over when
 * `state.alerted` is back to `none`.
 */
export function evaluatePrimaryWithoutReplicas(
  state: ShardReplicaState,
  input: PrimaryReplicaInput,
  config: PrimaryWithoutReplicasConfig,
): PrimaryWithoutReplicasFinding | null {
  // A restarted node reports role:master with no slots until it is re-joined
  // as a replica. It causes this state; it is not a primary at risk.
  if (input.role !== 'master' || input.ownsSlots === false) return null;

  const { timestamp, attached, synced } = input;
  state.lastSeenAt = timestamp;

  const expectationExpired = timestamp - state.expectedSeenAt > config.expectationTtlMs;
  if (attached >= state.expectedReplicas || expectationExpired) {
    state.expectedReplicas = attached;
    state.expectedSeenAt = timestamp;
  }

  if (synced > 0 || state.expectedReplicas === 0) {
    state.zeroSince = null;
    if (state.alerted === 'none') return null;
    state.healthyPolls += 1;
    if (state.healthyPolls >= PRIMARY_NO_REPLICA_RESOLVE_POLLS) {
      state.alerted = 'none';
      state.healthyPolls = 0;
    }
    return null;
  }

  state.healthyPolls = 0;
  state.zeroSince ??= timestamp;
  const zeroForMs = timestamp - state.zeroSince;

  const warn = config.warnMs > 0 && zeroForMs >= config.warnMs;
  const nothingAttachedAndNoPersistence = input.persistenceOff === true && attached === 0;
  const critical =
    config.critMs > 0 && (zeroForMs >= config.critMs || (warn && nothingAttachedAndNoPersistence));
  const level = critical ? 'critical' : warn ? 'warning' : 'none';
  if (LEVEL_RANK[level] <= LEVEL_RANK[state.alerted]) return null;

  state.alerted = level;
  return {
    severity: level === 'critical' ? 'critical' : 'warning',
    attached,
    synced,
    expected: state.expectedReplicas,
    zeroForMs,
    persistenceOff: input.persistenceOff,
    message: buildMessage(input, state.expectedReplicas, zeroForMs),
  };
}
