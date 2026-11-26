import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RebalanceRun } from '../../types/anomaly';

const { getRebalanceRuns, getRebalanceRunHistory, cancelRebalance, canMutate } = vi.hoisted(
  () => ({
    getRebalanceRuns: vi.fn(),
    getRebalanceRunHistory: vi.fn(),
    cancelRebalance: vi.fn(),
    canMutate: vi.fn(() => true),
  }),
);

vi.mock('../../api/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/metrics')>();
  return {
    ...actual,
    metricsApi: { getRebalanceRuns, getRebalanceRunHistory, cancelRebalance },
  };
});
vi.mock('../../hooks/useCanMutate', () => ({ useCanMutate: canMutate }));

import { ApiError } from '../../api/client';
import { RebalanceRuns } from './RebalanceRuns';

const SOURCE = '3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d';
const TARGET = '9c4e1b7a2d5f8036a1c3e5f7092b4d6f8a0c2e4b';

function run(overrides: Partial<RebalanceRun> = {}): RebalanceRun {
  return {
    sourceShardId: SOURCE,
    sourceAddr: '10.0.0.1:6379',
    startedBy: { userId: 'u1', email: 'admin@example.com' },
    startedAt: 1_000,
    projectedRatio: 1.19,
    jobs: [
      {
        targetShardId: TARGET,
        targetAddr: '10.0.0.3:6379',
        ranges: [
          [2000, 2410],
          [2500, 2500],
        ],
        state: 'running',
        jobName: 'job-1',
        phase: 'snapshotting',
      },
    ],
    state: 'running',
    ...overrides,
  };
}

async function show(
  runs: RebalanceRun[],
  { showHistory = false } = {},
): Promise<QueryClient> {
  getRebalanceRuns.mockResolvedValue(runs);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RebalanceRuns connectionId="conn-1" showHistory={showHistory} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await client.invalidateQueries();
  });
  return client;
}

const panel = () => screen.findByRole('region', { name: /slot rebalance from shard 3f2a9c1e/i });

describe('RebalanceRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canMutate.mockReturnValue(true);
  });

  it('shows who started a running migration and how far each job is', async () => {
    await show([run()]);

    const region = await panel();
    expect(within(region).getByText('Running')).toBeInTheDocument();
    expect(region).toHaveTextContent('Started from BetterDB by admin@example.com');
    expect(region).toHaveTextContent('Slots 2000-2410, 2500 to 10.0.0.3:6379: running (snapshotting).');
  });

  it('compares the projected and measured ratio once the slots moved', async () => {
    const done = { ...run().jobs[0], state: 'succeeded' as const };
    await show([
      run({
        state: 'succeeded',
        endedAt: 5_000,
        jobs: [done],
        outcome: { projectedRatio: 1.19, actualRatio: 1.31, measuredAt: 70_000 },
      }),
    ]);

    const region = await panel();
    expect(within(region).getByText('Done')).toBeInTheDocument();
    expect(region).toHaveTextContent('Projected 1.19x the median for the hot shard; measured 1.31x.');
    expect(within(region).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('says the load is still being measured right after the move', async () => {
    await show([run({ state: 'succeeded', endedAt: 5_000, jobs: [{ ...run().jobs[0], state: 'succeeded' }] })]);

    expect(await panel()).toHaveTextContent('Measuring the load now that the slots have moved.');
  });

  it('says when the load after the move could not be measured', async () => {
    await show([
      run({
        state: 'succeeded',
        endedAt: 5_000,
        jobs: [{ ...run().jobs[0], state: 'succeeded' }],
        outcomeUnavailable: true,
      }),
    ]);

    const region = await panel();
    expect(region).toHaveTextContent('The load after the move could not be measured.');
    expect(region).not.toHaveTextContent('Measuring the load');
  });

  it('keeps the last runs and their cancel when a refresh fails', async () => {
    const client = await show([run()]);
    await panel();

    getRebalanceRuns.mockRejectedValue(new Error('Network error'));
    await act(async () => {
      await client.invalidateQueries();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not refresh the slot rebalance runs. The last state read is shown.',
    );
    expect(within(await panel()).getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows the server message of a failed job', async () => {
    await show([
      run({
        state: 'failed',
        endedAt: 5_000,
        jobs: [{ ...run().jobs[0], state: 'failed', message: 'target ran out of memory' }],
      }),
    ]);

    expect(await panel()).toHaveTextContent('failed: target ran out of memory.');
  });

  it('cancels every migration on the source after a confirm', async () => {
    cancelRebalance.mockResolvedValue(run());
    await show([run()]);

    fireEvent.click(within(await panel()).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('It stops every slot migration on that shard');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel the migration' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cancelRebalance).toHaveBeenCalledWith(SOURCE);
  });

  it('says so when the migration already ended', async () => {
    cancelRebalance.mockRejectedValue(new ApiError('Conflict', 409, { reason: 'not_running' }));
    await show([run()]);
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel the migration' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The migration is no longer running.',
    );
  });

  it('says why a cancel is blocked', async () => {
    cancelRebalance.mockRejectedValue(new ApiError('Forbidden', 403, { blockedBy: 'flag_off' }));
    await show([run()]);
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel the migration' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'BETTERDB_SLOT_MIGRATION=true',
    );
  });

  it('offers no cancel to a read-only member', async () => {
    canMutate.mockReturnValue(false);
    await show([run()]);

    expect(within(await panel()).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  describe('history', () => {
    const toggle = () => screen.findByRole('button', { name: /slot rebalance history/i });

    it('is not offered unless asked for', async () => {
      await show([run()]);
      await panel();

      expect(screen.queryByRole('button', { name: /slot rebalance history/i })).toBeNull();
    });

    it('is closed at first and reads nothing', async () => {
      await show([], { showHistory: true });

      expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(getRebalanceRunHistory).not.toHaveBeenCalled();
    });

    it('lists the stored runs with their outcome once opened', async () => {
      getRebalanceRunHistory.mockResolvedValue([
        run({
          state: 'succeeded',
          endedAt: 5_000,
          outcome: { projectedRatio: 1.19, actualRatio: 1.31, measuredAt: 70_000 },
        }),
      ]);
      await show([], { showHistory: true });

      fireEvent.click(await toggle());

      const entry = await screen.findByRole('listitem');
      expect(getRebalanceRunHistory).toHaveBeenCalledTimes(1);
      expect(entry).toHaveTextContent('Shard 3f2a9c1e at 10.0.0.1:6379');
      expect(entry).toHaveTextContent('Done');
      expect(entry).toHaveTextContent('To 10.0.0.3:6379.');
      expect(entry).toHaveTextContent('Started by admin@example.com');
      expect(entry).toHaveTextContent('Projected 1.19x the median for the hot shard; measured 1.31x.');
      expect(within(entry).queryByRole('button')).toBeNull();
    });

    it('says so when no run was stored', async () => {
      getRebalanceRunHistory.mockResolvedValue([]);
      await show([], { showHistory: true });

      fireEvent.click(await toggle());

      expect(
        await screen.findByText('No slot rebalance was started in the last 7 days.'),
      ).toBeInTheDocument();
    });

    it('keeps the stored runs and warns when a refresh of the history fails', async () => {
      getRebalanceRunHistory.mockResolvedValue([run({ state: 'succeeded', endedAt: 5_000 })]);
      const client = await show([], { showHistory: true });
      fireEvent.click(await toggle());
      await screen.findByRole('listitem');

      getRebalanceRunHistory.mockRejectedValue(new Error('Network error'));
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['slot-rebalance-history'] });
      });

      expect(await screen.findByRole('alert', {}, { timeout: 5_000 })).toHaveTextContent(
        'Could not refresh the slot rebalance history. The last list read is shown.',
      );
      expect(screen.getByRole('listitem')).toHaveTextContent('Done');
    });
    it('is offered when the live runs cannot be read', async () => {
      getRebalanceRuns.mockRejectedValue(new Error('Network error'));
      getRebalanceRunHistory.mockResolvedValue([]);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <RebalanceRuns connectionId="conn-1" showHistory />
        </QueryClientProvider>,
      );
      fireEvent.click(await toggle());
      expect(
        await screen.findByText('No slot rebalance was started in the last 7 days.'),
      ).toBeInTheDocument();
    });
    it('says so when the history cannot be read', async () => {
      getRebalanceRunHistory.mockRejectedValue(new Error('Network error'));
      await show([], { showHistory: true });

      fireEvent.click(await toggle());

      expect(await screen.findByRole('alert', {}, { timeout: 5_000 })).toHaveTextContent(
        'Could not read the slot rebalance history.',
      );
    });
  });
});
