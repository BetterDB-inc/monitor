import { parseRaftState, isRaftSeeking, RaftState } from '../raft-health-detector';

// Field values below are taken from a live 3-node Valkey Cluster V2 (Raft) build.
describe('parseRaftState', () => {
  it('returns null in gossip mode (no cluster_raft_* fields)', () => {
    expect(parseRaftState({ cluster_state: 'ok', cluster_size: '3' })).toBeNull();
  });

  it('parses the raft block from CLUSTER INFO', () => {
    expect(
      parseRaftState({
        cluster_state: 'ok',
        cluster_raft_role: 'leader',
        cluster_raft_current_term: '2',
        cluster_raft_commit_index: '9',
        cluster_raft_last_applied: '9',
        cluster_raft_log_entries: '9',
        cluster_raft_leader: '4adc1ba9b9a4dd2cdaad18f8f73f6bedc3bc4c7a',
      }),
    ).toEqual<RaftState>({
      role: 'leader',
      currentTerm: 2,
      commitIndex: 9,
      lastApplied: 9,
      logEntries: 9,
      leaderId: '4adc1ba9b9a4dd2cdaad18f8f73f6bedc3bc4c7a',
      clusterState: 'ok',
    });
  });
});

describe('isRaftSeeking', () => {
  const state = (over: Partial<RaftState>): RaftState => ({
    role: 'follower',
    currentTerm: 2,
    commitIndex: 10,
    lastApplied: 10,
    logEntries: 10,
    leaderId: 'x',
    clusterState: 'ok',
    ...over,
  });

  it('true when the node is seeking a leader (pre-candidate)', () => {
    // Verified against a live majority-loss: cluster_state stays "ok", so the
    // seeking role — not cluster_state — is the quorum-loss signal.
    expect(isRaftSeeking(state({ clusterState: 'ok', role: 'pre-candidate' }))).toBe(true);
  });

  it('true for a full candidate', () => {
    expect(isRaftSeeking(state({ role: 'candidate' }))).toBe(true);
  });

  it('false for a healthy follower', () => {
    expect(isRaftSeeking(state({ role: 'follower' }))).toBe(false);
  });

  it('false for the leader', () => {
    expect(isRaftSeeking(state({ role: 'leader' }))).toBe(false);
  });

  it('false for a joining node', () => {
    expect(isRaftSeeking(state({ role: 'joiner' }))).toBe(false);
  });
});
