import { ClusterNode } from '@app/common/types/metrics.types';

/**
 * Detects the stuck-cluster state behind valkey-io/valkey#2090: after a primary
 * is lost and replaced by a fresh node (e.g. a k8s pod restart brings the node
 * back at the same address but with a new node id and shard id), a surviving
 * replica keeps pointing at the *old* primary and never adopts the replacement.
 * The replica is orphaned — its primary is gone — and, without operator action
 * (`CLUSTER REPLICATE <new-primary-id>`), it stays that way indefinitely.
 *
 * The observable symptom in any single node's `CLUSTER NODES` view is a replica
 * whose `master` (the primary node id it replicates) resolves to a node that is
 * dead (`fail`/`fail?`/`noaddr`) or is absent from the view entirely. Note that
 * `CLUSTER NODES` does not expose shard ids (those live in `nodes.conf` /
 * `CLUSTER SHARDS`), so detection is based on the always-present flags + master
 * fields; a shard-id-aware refinement using `CLUSTER SHARDS` can layer on later.
 *
 * IMPORTANT — this is a *snapshot* detector. A brief window where a replica
 * still points at a just-failed primary is also normal during an ordinary
 * failover, before the replica is promoted or re-points. The caller MUST require
 * the same orphaned replica to persist across several polls (roughly ≥ the
 * cluster node timeout) before alerting, so a healthy failover never trips it.
 */

/** Flags that mark a primary as unusable (dead / unreachable / not yet gossiped). */
const DEAD_PRIMARY_FLAGS = ['fail', 'fail?', 'noaddr', 'handshake'];

export type StuckReplicaReason =
  /** The replica's primary is present in the view but flagged dead/unreachable. */
  | 'primary_failed'
  /** The replica's primary node id does not appear in the view at all. */
  | 'primary_unknown';

export interface StuckReplica {
  replicaId: string;
  replicaAddress: string;
  /** Node id the replica is trying to replicate (its `master`). */
  primaryId: string;
  /** Address of that primary if it is still present in the view, else null. */
  primaryAddress: string | null;
  reason: StuckReplicaReason;
}

/** A node is a replica if it carries the replica/slave flag and names a primary. */
function isReplica(node: ClusterNode): boolean {
  return (
    (node.flags.includes('slave') || node.flags.includes('replica')) &&
    !!node.master &&
    node.master !== '-'
  );
}

/** A primary is healthy (a valid replication target) if master-flagged and not dead. */
function isHealthyPrimary(node: ClusterNode): boolean {
  return (
    node.flags.includes('master') && !DEAD_PRIMARY_FLAGS.some((flag) => node.flags.includes(flag))
  );
}

/**
 * Returns every replica whose primary is dead or missing from this `CLUSTER
 * NODES` view. Replicas with a healthy primary — the normal case — are ignored,
 * as are non-replica nodes. Callers should gate on persistence over time to
 * exclude the transient orphaned window of a normal failover (see file header).
 */
export function detectStuckReplicas(nodes: ClusterNode[]): StuckReplica[] {
  const byId = new Map<string, ClusterNode>();
  for (const node of nodes) {
    if (node.id) byId.set(node.id, node);
  }

  const stuck: StuckReplica[] = [];
  for (const replica of nodes) {
    if (!isReplica(replica)) continue;

    const primary = byId.get(replica.master);
    if (primary && isHealthyPrimary(primary)) continue; // normal: healthy primary

    stuck.push({
      replicaId: replica.id,
      replicaAddress: replica.address,
      primaryId: replica.master,
      primaryAddress: primary ? primary.address : null,
      reason: primary ? 'primary_failed' : 'primary_unknown',
    });
  }

  return stuck;
}

/**
 * Stable signature for a stuck replica, used to dedupe repeat alerts across
 * polls and to key the persistence gate. Keyed on the (replica, primary) pair so
 * a replica re-pointing at a new primary is treated as a distinct observation.
 */
export function stuckReplicaSignature(s: StuckReplica): string {
  return `${s.replicaId}|${s.primaryId}`;
}

/**
 * Full-resync failure loop (valkey-io/valkey#1836): a replica that connects,
 * starts a full sync, fails to complete it (transferred RDB unloadable — disk
 * errors, corruption, permissions, out-of-space — or the transfer itself dying)
 * and retries forever. `master_link_status` never leaves `down`, so the replica
 * serves stale data indefinitely while looking "merely syncing" at any single
 * glance. Unlike the CLUSTER NODES snapshot detector above, this one folds INFO
 * replication/stats fields from the polled replica itself across polls, so it
 * works in standalone and cluster mode alike.
 */

/** Minimum continuous link-down window before the loop signature may fire. */
export const RESYNC_LOOP_MIN_WINDOW_MS = 300_000;
/**
 * Failed full-sync cycles required within the window. A normal first sync of a
 * large dataset legitimately holds the link down for a long time but is ONE
 * attempt that is still progressing; a loop is the same attempt dying and
 * restarting.
 */
export const RESYNC_LOOP_MIN_CYCLES = 2;

export interface ResyncLoopInput {
  /** INFO replication `role`. */
  role: string;
  /** INFO replication `master_link_status`; null when the field is absent. */
  masterLinkStatus: string | null;
  /** INFO replication `master_link_down_since_seconds`; null when absent. */
  masterLinkDownSinceSeconds: number | null;
  /** INFO replication `master_sync_in_progress` as a boolean. */
  masterSyncInProgress: boolean;
  /** INFO stats `sync_full` (lifetime counter); null when absent. */
  syncFull: number | null;
  timestamp: number;
}

export interface ResyncLoopState {
  /** First poll timestamp of the current continuous link-down window. */
  downWindowStart: number | null;
  /** Last observed master_link_down_since_seconds, for the monotonicity check. */
  lastDownSinceSeconds: number | null;
  /** Last observed sync_full, for delta computation. */
  lastSyncFull: number | null;
  /** Whether the previous poll reported a sync in progress. */
  syncWasInProgress: boolean;
  /** Failed full-sync cycles observed in the current window. */
  failedCycles: number;
  /** Whether the current loop was already alerted (emit acknowledged). */
  alerted: boolean;
}

export interface ResyncLoopFinding {
  /** How long the link has been continuously down, in seconds. */
  downSeconds: number;
  failedCycles: number;
  message: string;
  timestamp: number;
}

export function createResyncLoopState(): ResyncLoopState {
  return {
    downWindowStart: null,
    lastDownSinceSeconds: null,
    lastSyncFull: null,
    syncWasInProgress: false,
    failedCycles: 0,
    alerted: false,
  };
}

function resetResyncLoopState(state: ResyncLoopState): void {
  state.downWindowStart = null;
  state.lastDownSinceSeconds = null;
  state.lastSyncFull = null;
  state.syncWasInProgress = false;
  state.failedCycles = 0;
  state.alerted = false;
}

/**
 * Folds one poll of INFO replication/stats fields into the connection state and
 * returns a finding to emit, or null. Mutates `state`. The returned finding
 * keeps being produced every poll until `acknowledgeResyncLoopFinding` is
 * called, so a failed emit retries next poll; recovery (link up, promotion, or
 * a demonstrated brief `up` between polls) clears everything so a later loop
 * alerts again.
 */
export function evaluateResyncLoop(
  state: ResyncLoopState,
  input: ResyncLoopInput,
): ResyncLoopFinding | null {
  const linkDown = input.role === 'slave' && input.masterLinkStatus === 'down';
  if (linkDown === false) {
    // Link up, promoted to primary, or not a replica at all: whatever loop was
    // in flight has ended. Clear so a future loop earns the window afresh.
    resetResyncLoopState(state);
    return null;
  }

  // A drop in the server-side down counter means the link reached `up` between
  // polls (a sync DID complete) and went down again afterwards — by definition
  // not a never-completing loop. Restart the window from here.
  const downCounterDropped =
    state.lastDownSinceSeconds !== null &&
    input.masterLinkDownSinceSeconds !== null &&
    input.masterLinkDownSinceSeconds < state.lastDownSinceSeconds;
  if (downCounterDropped === true) {
    resetResyncLoopState(state);
  }
  if (input.masterLinkDownSinceSeconds !== null) {
    state.lastDownSinceSeconds = input.masterLinkDownSinceSeconds;
  }
  if (state.downWindowStart === null) {
    state.downWindowStart = input.timestamp;
  }

  // A failed cycle is a NEW full-sync attempt while the link stayed down:
  // preferably the sync_full counter moving; where it doesn't move on the
  // replica, a sync-in-progress flag falling back to 0 with the link still
  // down (the attempt ended, yet the link never came up).
  let cycleIncrement = 0;
  if (
    state.lastSyncFull !== null &&
    input.syncFull !== null &&
    input.syncFull > state.lastSyncFull
  ) {
    cycleIncrement = input.syncFull - state.lastSyncFull;
  } else if (state.syncWasInProgress === true && input.masterSyncInProgress === false) {
    cycleIncrement = 1;
  }
  state.failedCycles += cycleIncrement;
  if (input.syncFull !== null) {
    state.lastSyncFull = input.syncFull;
  }
  state.syncWasInProgress = input.masterSyncInProgress;

  const windowElapsed = input.timestamp - state.downWindowStart >= RESYNC_LOOP_MIN_WINDOW_MS;
  if (
    windowElapsed === false ||
    state.failedCycles < RESYNC_LOOP_MIN_CYCLES ||
    state.alerted === true
  ) {
    return null;
  }

  const downSeconds =
    input.masterLinkDownSinceSeconds ??
    Math.round((input.timestamp - state.downWindowStart) / 1000);

  return {
    downSeconds,
    failedCycles: state.failedCycles,
    message:
      `WARNING: Replica has been unable to sync with its primary for ${downSeconds}s: ` +
      `master_link_status has stayed down through ${state.failedCycles} full-sync attempts ` +
      `that never completed — the replica is looping on full resync and serving stale data ` +
      `(valkey#1836). Check primary reachability and authentication, replica disk space and ` +
      `permissions, and RDB integrity on the replica side (a corrupted transfer, e.g. by a ` +
      `filesystem layer or antivirus, reproduces exactly this signature).`,
    timestamp: input.timestamp,
  };
}

/**
 * Marks the current loop as alerted after a successful emit, so a persisting
 * loop alerts once (not every poll). A failed emit (caller doesn't acknowledge)
 * re-produces the finding next poll; recovery clears the flag.
 */
export function acknowledgeResyncLoopFinding(state: ResyncLoopState): void {
  state.alerted = true;
}
