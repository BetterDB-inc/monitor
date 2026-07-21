/**
 * Health signals for Valkey's Raft-based cluster (Cluster V2, `cluster-protocol
 * raft`). In Raft mode `CLUSTER INFO` gains a block of `cluster_raft_*` fields;
 * this module parses them from the connected node's own view and derives the two
 * signals that mode is uniquely prone to.
 *
 * Field semantics were verified against a live 3-node Raft cluster built from the
 * upstream `cluster-v2` branch:
 *   cluster_raft_role         leader | follower | candidate | pre-candidate | joiner
 *   cluster_raft_current_term monotonic election term
 *   cluster_raft_commit_index / _last_applied / _log_entries  replicated-log progress
 *   cluster_raft_leader       node id of the current leader (may be stale/dead)
 *
 * Observed behaviours that shape the detectors (verified by killing the majority
 * of a live 3-node group and sampling `CLUSTER INFO`/`CLUSTER NODES` for 60s):
 *   - Healthy failover (leader lost, majority intact) elects a new leader within
 *     ~1s, `cluster_state` stays `ok`, and the commit index advances (the new
 *     leader commits a no-op entry on election).
 *   - Quorum loss (majority down) does NOT set `cluster_state:fail` on a
 *     surviving replica: it keeps reporting `cluster_state:ok` (its slots stay
 *     "covered") and `CLUSTER NODES` shows every peer `connected` — the gossip
 *     fail-flags never propagate without quorum. The term does NOT inflate
 *     either (the pre-vote protocol blocks it). The ONLY observable signature is
 *     therefore: the node repeatedly re-enters `candidate`/`pre-candidate`
 *     (seeking a leader it can never elect) while the commit index stays frozen.
 *     So quorum loss is "seeking + no commit progress", NOT `cluster_state=fail`.
 *   - Term climbing repeatedly means genuine *completed* elections (flapping
 *     leadership with quorum), which is the churn signal — distinct from the
 *     term-frozen seeking of a quorum outage.
 */

export interface RaftState {
  role: string;
  currentTerm: number;
  commitIndex: number;
  lastApplied: number;
  logEntries: number;
  leaderId: string;
  clusterState: string; // ok | fail
}

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse the Raft block from a `CLUSTER INFO` record. Returns null when the node
 * is NOT running the Raft protocol (no `cluster_raft_*` fields) — callers use
 * that as the mode gate so gossip-mode nodes are skipped.
 */
export function parseRaftState(clusterInfo: Record<string, string>): RaftState | null {
  if (clusterInfo['cluster_raft_role'] === undefined) return null;
  return {
    role: clusterInfo['cluster_raft_role'] ?? '',
    currentTerm: num(clusterInfo['cluster_raft_current_term']),
    commitIndex: num(clusterInfo['cluster_raft_commit_index']),
    lastApplied: num(clusterInfo['cluster_raft_last_applied']),
    logEntries: num(clusterInfo['cluster_raft_log_entries']),
    leaderId: clusterInfo['cluster_raft_leader'] ?? '',
    clusterState: clusterInfo['cluster_state'] ?? '',
  };
}

/** Raft roles that mean the node currently has no leader and is trying to elect one. */
export const RAFT_SEEKING_ROLES = ['candidate', 'pre-candidate'];

/**
 * True when the node is actively seeking a leader (`candidate`/`pre-candidate`):
 * it stopped hearing from a leader and started an election. In a healthy cluster
 * this is rare and transient — an election completes in well under a second — so
 * a node that keeps re-entering this state (without the commit index advancing)
 * cannot assemble a majority, i.e. quorum is lost.
 *
 * This is the quorum-loss signal, NOT `cluster_state`: a surviving replica keeps
 * reporting `cluster_state:ok` through a majority outage (see the module header).
 * Callers combine this predicate with a frozen-commit-index check and a duration
 * gate so a healthy failover (which advances the commit index within ~1s) is
 * excluded and only a sustained inability to elect a leader alerts.
 */
export function isRaftSeeking(s: RaftState): boolean {
  return RAFT_SEEKING_ROLES.includes(s.role);
}
