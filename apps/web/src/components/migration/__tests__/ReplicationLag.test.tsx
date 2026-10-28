import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReplicationLag } from '../ReplicationLag';

describe('ReplicationLag', () => {
  it('shows the worst shard lag', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, stale: false }, { shard: 'src-1', diff: 2048, stale: false }]}
        expectedShards={2}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('Lag: 2.00 KB behind');
  });

  it('says how many shards have not reported', () => {
    render(<ReplicationLag entries={[{ shard: 'src-0', diff: 0, stale: false }]} expectedShards={6} />);
    expect(screen.getByRole('button').textContent).toContain('· waiting for 5 of 6 shards');
  });

  it('shows initial sync when no shard has a diff', () => {
    render(<ReplicationLag entries={[{ shard: 'src-0', diff: null, stale: false }]} expectedShards={1} />);
    expect(screen.getByRole('button').textContent).toBe('Lag: initial sync');
  });

  it('says how many reported shards are still in initial sync', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, stale: false }, { shard: 'src-1', diff: null, stale: false }]}
        expectedShards={2}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('Lag: 0 B behind · 1 of 2 shards in initial sync');
  });

  it('expands a per-shard breakdown on click', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, stale: false }, { shard: 'src-1', diff: null, stale: false }]}
        expectedShards={2}
      />,
    );
    expect(screen.queryByText('src-0: 0 B')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('src-0: 0 B')).toBeTruthy();
    expect(screen.getByText('src-1: initial sync')).toBeTruthy();
  });

  it('flags stale rows', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, stale: false }, { shard: 'src-1', diff: 0, stale: true }]}
        expectedShards={2}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('src-1: 0 B · not updated recently')).toBeTruthy();
    expect(screen.getByText('src-0: 0 B')).toBeTruthy();
  });

  it('marks the readout when any shard is stale', () => {
    render(
      <ReplicationLag
        entries={[{ shard: 'src-0', diff: 0, stale: false }, { shard: 'src-1', diff: 512, stale: true }]}
        expectedShards={2}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('Lag: 512.00 B behind · not updated recently');
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(<ReplicationLag entries={[]} expectedShards={3} />);
    expect(container.innerHTML).toBe('');
  });
});
