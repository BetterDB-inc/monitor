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
 * Observed behaviours that shape the detectors:
 *   - Healthy failover (leader lost, majority intact) bumps the term exactly once
 *     and `cluster_state` stays `ok`.
 *   - Quorum loss (majority down) sets `cluster_state:fail`, no node reports
 *     `role:leader`, the commit index freezes, and — because of the pre-vote
 *     protocol — the term does NOT inflate. So quorum loss is "cluster_state=fail
 *     + leaderless", NOT "term climbing".
 *   - Term climbing repeatedly therefore means genuine repeated elections
 *     (flapping leadership), which is the churn signal.
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

/**
 * From a single connected node's view, the cluster has no usable leader when it
 * is down (`cluster_state:fail`) and this node is not itself the leader. Under
 * Raft this is the quorum-loss signature (majority unreachable → no election can
 * complete). Callers gate on persistence to exclude the brief election window of
 * a healthy failover, where `cluster_state` stays `ok` anyway.
 */
export function isRaftLeaderless(s: RaftState): boolean {
  return s.clusterState === 'fail' && s.role !== 'leader';
}
