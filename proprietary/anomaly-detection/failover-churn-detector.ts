import { ClusterNode } from '@app/common/types/metrics.types';

/**
 * Gossip-mode failover-churn detection (valkey-io/valkey#3996): multiple
 * coordinators issuing FAILOVER for the same shard (e.g. a dying node's
 * shutdown handler racing a Kubernetes operator's FAILOVER FORCE) make the
 * shard re-elect repeatedly — election resets, repeated promotions, and
 * multi-second stalls with no settled primary.
 *
 * From CLUSTER NODES the observable symptom is one shard whose configEpoch
 * advances (or whose slot-owning primary flips) repeatedly within a short
 * window. A single healthy failover is exactly one epoch bump plus one owner
 * change and must never fire; the churn signal starts at the third change
 * inside the window. Raft-mode (Cluster V2) churn is covered separately by
 * raft-health-detector via term advances — callers gate this detector to
 * gossip mode.
 *
 * The evaluator is deliberately re-entrant on an external state map (the
 * anomaly service holds one map per connection): findings keep being returned
 * until the caller acknowledges a successful emit, so a failed emit retries
 * on the next poll (same contract as the Raft churn window).
 */

export const FAILOVER_CHURN_WINDOW_MS = 60_000;
export const FAILOVER_CHURN_MIN_CHANGES = 3;
/** A shard absent from the topology for this long is forgotten. */
const SHARD_STATE_TTL_MS = 2 * FAILOVER_CHURN_WINDOW_MS;
/**
 * A post-fire threshold breach inside this horizon means the churn never
 * settled — the PRD's "continues across a second window" CRITICAL rule.
 */
const ESCALATION_HORIZON_MS = 2 * FAILOVER_CHURN_WINDOW_MS;
const EPOCH_TRAIL_LIMIT = 6;

const UNHEALTHY_PRIMARY_FLAGS = ['fail', 'fail?', 'handshake', 'noaddr'];

export interface ShardObservation {
  /** Canonical sorted slot ranges of the owning primary, e.g. `0-5460,10923-16383`. */
  shardKey: string;
  ownerId: string;
  configEpoch: number;
  /** True while the owner is migrating/importing slots — epoch bumps are then legitimate. */
  resharding: boolean;
}

export interface ShardChurnState {
  lastEpoch: number;
  lastOwner: string;
  epochBumpTimes: number[];
  ownerFlipTimes: number[];
  epochTrail: number[];
  lastFireAt: number | null;
  lastSeenAt: number;
}

export type FailoverChurnStateMap = Map<string, ShardChurnState>;

export interface FailoverChurnFinding {
  shardKey: string;
  ownerId: string;
  changes: number;
  windowMs: number;
  epochTrail: number[];
  severity: 'warning' | 'critical';
  message: string;
}

function isLivePrimary(node: ClusterNode): boolean {
  const unhealthy = UNHEALTHY_PRIMARY_FLAGS.some((flag) => {
    return node.flags.includes(flag);
  });
  return node.flags.includes('master') && node.slots.length > 0 && unhealthy === false;
}

function canonicalSlotKey(slots: number[][]): string {
  const ranges = slots.map(([start, end]) => {
    return `${start}-${end}`;
  });
  ranges.sort((a, b) => {
    return parseInt(a, 10) - parseInt(b, 10);
  });
  return ranges.join(',');
}

function isResharding(node: ClusterNode): boolean {
  const migrating = node.migratingSlots ?? [];
  const importing = node.importingSlots ?? [];
  return migrating.length > 0 || importing.length > 0;
}

/**
 * Reduces a CLUSTER NODES snapshot to one observation per shard. A contested
 * shard (two live primaries claiming the same slots, valkey#2261 territory)
 * is attributed to the highest-epoch primary — the authoritative one. An
 * equal-epoch contest is broken by lexically smallest node id: CLUSTER NODES
 * line order is not stable poll-to-poll, and a first-wins resolution would
 * flip `ownerId` between polls, counting phantom owner changes toward a false
 * CRITICAL.
 */
export function extractShardOwnership(nodes: ClusterNode[]): ShardObservation[] {
  const byShard = new Map<string, ShardObservation>();
  for (const candidate of nodes) {
    if (isLivePrimary(candidate) === false) {
      continue;
    }
    const observation: ShardObservation = {
      shardKey: canonicalSlotKey(candidate.slots),
      ownerId: candidate.id,
      configEpoch: candidate.configEpoch,
      resharding: isResharding(candidate),
    };
    const existing = byShard.get(observation.shardKey);
    const takesOwnership =
      existing === undefined ||
      observation.configEpoch > existing.configEpoch ||
      (observation.configEpoch === existing.configEpoch && observation.ownerId < existing.ownerId);
    if (takesOwnership === true) {
      byShard.set(observation.shardKey, observation);
    }
  }
  return [...byShard.values()];
}

/** Ids of masters still claiming slots but excluded from liveness only by health flags. */
function unhealthyClaimantIds(nodes: ClusterNode[]): Set<string> {
  const ids = new Set<string>();
  for (const candidate of nodes) {
    const unhealthy = UNHEALTHY_PRIMARY_FLAGS.some((flag) => {
      return candidate.flags.includes(flag);
    });
    if (candidate.flags.includes('master') && candidate.slots.length > 0 && unhealthy === true) {
      ids.add(candidate.id);
    }
  }
  return ids;
}

function inWindow(times: number[], timestamp: number): number[] {
  return times.filter((t) => {
    return timestamp - t <= FAILOVER_CHURN_WINDOW_MS;
  });
}

function buildMessage(finding: Omit<FailoverChurnFinding, 'message'>): string {
  const seconds = Math.round(finding.windowMs / 1000);
  const trail = finding.epochTrail.join('→');
  return (
    `Shard ${finding.shardKey} has re-elected ${finding.changes} times in ${seconds}s ` +
    `(configEpoch ${trail}) — likely competing FAILOVER commands (valkey#3996). ` +
    `Ensure a single failover coordinator.`
  );
}

/**
 * Folds one CLUSTER NODES snapshot into the per-shard state map and returns
 * every shard currently over the churn threshold. Mutates `state`. Callers
 * must invoke `acknowledgeChurnFinding` after successfully emitting a
 * finding — until then the same finding is returned on every evaluation.
 */
export function evaluateFailoverChurn(
  state: FailoverChurnStateMap,
  nodes: ClusterNode[],
  timestamp: number,
): FailoverChurnFinding[] {
  const findings: FailoverChurnFinding[] = [];
  const observations = extractShardOwnership(nodes);
  const flappingClaimants = unhealthyClaimantIds(nodes);
  const seenShards = new Set<string>();

  for (const observation of observations) {
    seenShards.add(observation.shardKey);
    const existing = state.get(observation.shardKey);
    if (existing === undefined) {
      state.set(observation.shardKey, {
        lastEpoch: observation.configEpoch,
        lastOwner: observation.ownerId,
        epochBumpTimes: [],
        ownerFlipTimes: [],
        epochTrail: [observation.configEpoch],
        lastFireAt: null,
        lastSeenAt: timestamp,
      });
      continue;
    }

    existing.lastSeenAt = timestamp;

    // An attribution at a LOWER epoch than previously observed means the
    // authoritative primary is missing from this snapshot (e.g. a fail?/fail
    // health flap on a contested shard) — a genuine ownership change always
    // advances the epoch. Folding it in would count the flap and the
    // subsequent recovery as owner flips + an epoch bump, reading split-brain
    // health flapping as competing-FAILOVER churn.
    if (observation.configEpoch < existing.lastEpoch) {
      continue;
    }

    // Same logic for an equal-epoch contest: if the previous owner is still
    // in the snapshot claiming the slots and lost attribution only to a
    // health flag (fail?/fail flap), no election happened — a genuine
    // takeover at the same epoch never leaves the old owner as an unhealthy
    // claimant while a peer holds an identical epoch.
    if (
      observation.configEpoch === existing.lastEpoch &&
      observation.ownerId !== existing.lastOwner &&
      flappingClaimants.has(existing.lastOwner)
    ) {
      continue;
    }

    if (observation.resharding) {
      existing.lastEpoch = observation.configEpoch;
      existing.lastOwner = observation.ownerId;
      continue;
    }

    if (observation.configEpoch > existing.lastEpoch) {
      existing.epochBumpTimes.push(timestamp);
      existing.epochTrail.push(observation.configEpoch);
      if (existing.epochTrail.length > EPOCH_TRAIL_LIMIT) {
        existing.epochTrail.shift();
      }
    }
    if (observation.ownerId !== existing.lastOwner) {
      existing.ownerFlipTimes.push(timestamp);
    }
    existing.lastEpoch = observation.configEpoch;
    existing.lastOwner = observation.ownerId;

    existing.epochBumpTimes = inWindow(existing.epochBumpTimes, timestamp);
    existing.ownerFlipTimes = inWindow(existing.ownerFlipTimes, timestamp);

    const changes = Math.max(existing.epochBumpTimes.length, existing.ownerFlipTimes.length);
    if (changes < FAILOVER_CHURN_MIN_CHANGES) {
      continue;
    }

    const continued =
      existing.lastFireAt !== null && timestamp - existing.lastFireAt <= ESCALATION_HORIZON_MS;
    const withoutMessage = {
      shardKey: observation.shardKey,
      ownerId: observation.ownerId,
      changes,
      windowMs: FAILOVER_CHURN_WINDOW_MS,
      epochTrail: [...existing.epochTrail],
      severity: continued ? ('critical' as const) : ('warning' as const),
    };
    findings.push({ ...withoutMessage, message: buildMessage(withoutMessage) });
  }

  for (const [shardKey, shardState] of state) {
    if (seenShards.has(shardKey)) {
      continue;
    }
    if (timestamp - shardState.lastSeenAt > SHARD_STATE_TTL_MS) {
      state.delete(shardKey);
    }
  }

  return findings;
}

/**
 * Clears the counted window for a shard after its finding was successfully
 * emitted, and records the fire time for the two-window CRITICAL escalation.
 */
export function acknowledgeChurnFinding(
  state: FailoverChurnStateMap,
  shardKey: string,
  timestamp: number,
): void {
  const shardState = state.get(shardKey);
  if (shardState === undefined) {
    return;
  }
  shardState.epochBumpTimes = [];
  shardState.ownerFlipTimes = [];
  shardState.epochTrail = [shardState.lastEpoch];
  shardState.lastFireAt = timestamp;
}
