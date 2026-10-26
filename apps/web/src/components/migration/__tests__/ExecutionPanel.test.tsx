import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { MigrationExecutionResult } from '@betterdb/shared';
import { ExecutionPanel } from '../ExecutionPanel';
import { fetchApi } from '../../../api/client';

vi.mock('../../../api/client', () => ({
  fetchApi: vi.fn(),
}));

function syncResult(partial: Partial<MigrationExecutionResult>): MigrationExecutionResult {
  return {
    id: 'exec-1',
    status: 'running',
    mode: 'redis_shake_sync',
    startedAt: Date.now(),
    logs: [],
    progress: null,
    syncStage: 'aof_replicating',
    replicationLag: [{ shard: 'src-0', diff: 0, updatedAt: Date.now() }],
    expectedShards: 1,
    fullySynced: false,
    ...partial,
  };
}

describe('ExecutionPanel replication lag', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockReset();
  });

  it('shows Fully synced when the API says so', async () => {
    vi.mocked(fetchApi).mockResolvedValue(syncResult({ fullySynced: true }));
    render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
    expect(await screen.findByText('Fully synced')).toBeTruthy();
    expect(screen.queryByText(/ready for cutover/)).toBeNull();
  });

  it('shows Replicating while lag is non-zero', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      syncResult({ replicationLag: [{ shard: 'src-0', diff: 512, updatedAt: Date.now() }] }),
    );
    render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
    expect(await screen.findByText('Replicating')).toBeTruthy();
    expect(screen.getByText('Lag: 512.00 B behind')).toBeTruthy();
  });

  it('drops Fully synced while the latest poll has failed', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchApi)
        .mockResolvedValueOnce(syncResult({ fullySynced: true }))
        .mockRejectedValueOnce(new Error('network'));
      render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Fully synced')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.queryByText('Fully synced')).toBeNull();
      expect(screen.getByText('Replicating')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('points the banner at the lag readout', async () => {
    vi.mocked(fetchApi).mockResolvedValue(syncResult({}));
    render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
    expect(await screen.findByText(/the chip turns Fully synced/)).toBeTruthy();
  });
});
