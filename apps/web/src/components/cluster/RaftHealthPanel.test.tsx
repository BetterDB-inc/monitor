import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RaftHealthPanel } from './RaftHealthPanel';
import { parseRaftInfo } from './raft-info';

// Field values below are taken from a live 3-node Valkey Cluster V2 (Raft) build.
const leaderInfo: Record<string, string> = {
  cluster_state: 'ok',
  cluster_raft_role: 'leader',
  cluster_raft_current_term: '2',
  cluster_raft_commit_index: '9',
  cluster_raft_last_applied: '9',
  cluster_raft_log_entries: '9',
  cluster_raft_leader: '4adc1ba9b9a4dd2cdaad18f8f73f6bedc3bc4c7a',
};

describe('parseRaftInfo', () => {
  it('returns null in gossip mode (no cluster_raft_* fields)', () => {
    expect(parseRaftInfo({ cluster_state: 'ok', cluster_size: '3' })).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(parseRaftInfo(null)).toBeNull();
    expect(parseRaftInfo(undefined)).toBeNull();
  });

  it('parses the raft block from a CLUSTER INFO map', () => {
    expect(parseRaftInfo(leaderInfo)).toEqual({
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

describe('RaftHealthPanel', () => {
  it('renders nothing in gossip mode', () => {
    const { container } = render(
      <RaftHealthPanel clusterInfo={{ cluster_state: 'ok', cluster_size: '3' }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders role, term, log progress and leader for a healthy leader', () => {
    render(<RaftHealthPanel clusterInfo={leaderInfo} />);

    expect(screen.getByText('Cluster V2 · Raft Health')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Leader')).toBeInTheDocument();
    expect(screen.getByText('Current term')).toBeInTheDocument();
    expect(
      screen.getByText('4adc1ba9b9a4dd2cdaad18f8f73f6bedc3bc4c7a'),
    ).toBeInTheDocument();
  });

  it('shows a quorum-loss state and no leader when cluster_state is fail', () => {
    render(
      <RaftHealthPanel
        clusterInfo={{
          ...leaderInfo,
          cluster_state: 'fail',
          cluster_raft_role: 'pre-candidate',
          cluster_raft_leader: '',
        }}
      />,
    );

    expect(screen.getByText(/Fail \(no quorum\)/)).toBeInTheDocument();
    expect(screen.getByText('Pre-candidate')).toBeInTheDocument();
    expect(screen.getByText('none elected')).toBeInTheDocument();
  });

  it('shows "Electing" (not green OK) when seeking a leader while cluster_state is ok', () => {
    // Regression: the real majority-loss surface keeps cluster_state:"ok" while
    // the node re-seeks a leader. The panel must not claim a healthy OK here.
    render(
      <RaftHealthPanel
        clusterInfo={{ ...leaderInfo, cluster_state: 'ok', cluster_raft_role: 'pre-candidate' }}
      />,
    );
    expect(screen.getByText(/Electing — no leader/)).toBeInTheDocument();
    expect(screen.queryByText('OK')).not.toBeInTheDocument();
    expect(screen.getByText('Pre-candidate')).toBeInTheDocument();
  });

  it('surfaces apply lag when last-applied trails the commit index', () => {
    render(
      <RaftHealthPanel
        clusterInfo={{ ...leaderInfo, cluster_raft_commit_index: '20', cluster_raft_last_applied: '17' }}
      />,
    );
    expect(screen.getByText('(-3)')).toBeInTheDocument();
  });
});
