import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RebalanceRun } from '../../types/anomaly';

const { getRebalanceRuns, cancelRebalance, canMutate } = vi.hoisted(() => ({
  getRebalanceRuns: vi.fn(),
  cancelRebalance: vi.fn(),
  canMutate: vi.fn(() => true),
}));

vi.mock('../../api/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/metrics')>();
  return { ...actual, metricsApi: { getRebalanceRuns, cancelRebalance } };
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

async function show(runs: RebalanceRun[]): Promise<QueryClient> {
  getRebalanceRuns.mockResolvedValue(runs);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RebalanceRuns connectionId="conn-1" />
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

  it('offers no cancel to a read-only member', async () => {
    canMutate.mockReturnValue(false);
    await show([run()]);

    expect(within(await panel()).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
