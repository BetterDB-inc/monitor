import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
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
    cutover: null,
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

  it('points the replicating banner at Complete cutover', async () => {
    vi.mocked(fetchApi).mockResolvedValue(syncResult({}));
    render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
    expect(await screen.findByText(/then click Complete cutover/)).toBeTruthy();
  });
});

describe('ExecutionPanel cutover', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockReset();
  });

  it('shows Completing and a countdown while completing', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      syncResult({
        status: 'completing',
        cutover: { requestedAt: Date.now(), deadlineAt: Date.now() + 65_000, outcome: 'waiting' },
      }),
    );
    render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
    expect(await screen.findByText('Completing cutover')).toBeTruthy();
    expect(screen.getByText('Completing')).toBeTruthy();
    expect(screen.getByText(/Waiting for zero lag · 1m \d+s left/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop Migration' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete cutover' })).toBeNull();
  });

  it('posts to the complete endpoint and keeps polling', async () => {
    const onStopped = vi.fn();
    vi.mocked(fetchApi).mockImplementation(async (path: string) =>
      path.endsWith('/complete') ? { status: 'completing', cutover: null } : syncResult({}),
    );
    render(<ExecutionPanel executionId="exec-1" onStopped={onStopped} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete cutover' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
    });
    expect(fetchApi).toHaveBeenCalledWith('/migration/execution/exec-1/complete', {
      method: 'POST',
      body: JSON.stringify({ force: false }),
    });
    expect(onStopped).not.toHaveBeenCalled();
  });

  it('ignores a poll that started before the cutover request', async () => {
    let resolveStalePoll: (value: MigrationExecutionResult) => void = () => {};
    let gets = 0;
    vi.mocked(fetchApi).mockImplementation(async (path: string) => {
      if (path.endsWith('/complete')) {
        return {
          status: 'completing',
          cutover: { requestedAt: Date.now(), deadlineAt: Date.now() + 300_000, outcome: 'waiting' },
        };
      }
      gets++;
      if (gets === 1) return syncResult({});
      return new Promise<MigrationExecutionResult>((resolve) => { resolveStalePoll = resolve; });
    });
    vi.useFakeTimers();
    try {
      render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(gets).toBe(2);
      fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Completing cutover')).toBeTruthy();
      await act(async () => {
        resolveStalePoll(syncResult({}));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Completing cutover')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Complete cutover' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the timed-out banner with retry and force', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      syncResult({ cutover: { requestedAt: 1, deadlineAt: 2, outcome: 'timed_out' } }),
    );
    render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
    expect(await screen.findByText(/Cutover timed out/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry cutover' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Force cutover' })).toBeTruthy();
  });

  it('shows the cutover-complete banner', async () => {
    const cutoverAt = Date.now();
    vi.mocked(fetchApi).mockResolvedValue(
      syncResult({
        status: 'completed',
        cutover: { requestedAt: 1, deadlineAt: 2, outcome: 'completed' },
        cutoverAt,
      }),
    );
    render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
    expect(
      await screen.findByText(
        `Cutover complete at ${new Date(cutoverAt).toLocaleTimeString()}. Point your application at the target.`,
      ),
    ).toBeTruthy();
  });

  it('shows the accepted lag after a forced cutover', async () => {
    vi.mocked(fetchApi).mockResolvedValue(
      syncResult({
        status: 'completed',
        cutover: { requestedAt: 1, deadlineAt: 2, outcome: 'forced', forcedLag: [] },
        cutoverAt: Date.now(),
        notices: ['Forced cutover with src-0 4 KB behind.'],
      }),
    );
    render(<ExecutionPanel executionId="exec-1" onStopped={() => {}} />);
    expect(await screen.findByText(/Cutover complete at .* Forced cutover with src-0 4 KB behind\./)).toBeTruthy();
  });
});
