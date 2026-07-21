/**
 * Client-side view of the Raft block that `CLUSTER INFO` gains under Valkey
 * Cluster V2 (`cluster-protocol raft`). Field semantics were verified against a
 * live 3-node Raft build from the upstream `cluster-v2` branch.
 */
export interface RaftInfo {
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
 * Parse the Raft block from a raw `CLUSTER INFO` map. Returns null when the node
 * is NOT running the Raft protocol (no `cluster_raft_*` fields) — i.e. legacy
 * gossip mode — so the panel hides itself entirely rather than showing empty
 * rows. This mirrors the backend detector's mode gate.
 */
export function parseRaftInfo(
  clusterInfo: Record<string, string> | null | undefined,
): RaftInfo | null {
  if (!clusterInfo || clusterInfo['cluster_raft_role'] === undefined) return null;
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
