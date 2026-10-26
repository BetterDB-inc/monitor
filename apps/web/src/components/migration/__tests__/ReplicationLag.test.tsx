import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReplicationLag } from '../ReplicationLag';

const NOW = 1_000_000;

describe('ReplicationLag', () => {
  it('shows the worst shard lag', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, updatedAt: NOW }, { shard: 'src-1', diff: 2048, updatedAt: NOW }]}
        expectedShards={2}
        now={NOW}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('Lag: 2.00 KB behind');
  });

  it('says how many shards have not reported', () => {
    render(<ReplicationLag entries={[{ shard: 'src-0', diff: 0, updatedAt: NOW }]} expectedShards={6} now={NOW} />);
    expect(screen.getByRole('button').textContent).toContain('· waiting for 5 of 6 shards');
  });

  it('shows initial sync when no shard has a diff', () => {
    render(<ReplicationLag entries={[{ shard: 'src-0', diff: null, updatedAt: NOW }]} expectedShards={1} now={NOW} />);
    expect(screen.getByRole('button').textContent).toBe('Lag: initial sync');
  });

  it('says how many reported shards are still in initial sync', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, updatedAt: NOW }, { shard: 'src-1', diff: null, updatedAt: NOW }]}
        expectedShards={2}
        now={NOW}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('Lag: 0 B behind · 1 of 2 shards in initial sync');
  });

  it('expands a per-shard breakdown on click', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, updatedAt: NOW }, { shard: 'src-1', diff: null, updatedAt: NOW }]}
        expectedShards={2}
        now={NOW}
      />,
    );
    expect(screen.queryByText('src-0: 0 B')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('src-0: 0 B')).toBeTruthy();
    expect(screen.getByText('src-1: initial sync')).toBeTruthy();
  });

  it('flags stale rows with their age', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, updatedAt: NOW }, { shard: 'src-1', diff: 0, updatedAt: NOW - 30_000 }]}
        expectedShards={2}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('src-1: 0 B · updated 30s ago')).toBeTruthy();
    expect(screen.getByText('src-0: 0 B')).toBeTruthy();
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(<ReplicationLag entries={[]} expectedShards={3} now={NOW} />);
    expect(container.innerHTML).toBe('');
  });
});
