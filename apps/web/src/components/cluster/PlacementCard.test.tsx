import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  PlacementBalance,
  PlacementMode,
  PlacementStatus,
  PlacementSupportIssue,
  PlacementSupportReason,
} from '@betterdb/shared';

const { get, setMode, canMutate, license } = vi.hoisted(() => ({
  get: vi.fn(),
  setMode: vi.fn(),
  canMutate: vi.fn(() => true),
  license: { licensed: true },
}));

vi.mock('../../api/placement', () => ({ placementApi: { get, setMode } }));
vi.mock('../../hooks/useCanMutate', () => ({ useCanMutate: canMutate }));
vi.mock('../../hooks/useLicense', () => ({
  useLicense: () => ({ license: null, hasFeature: () => license.licensed }),
}));
vi.mock('../anomalies/RebalanceSuggestion', () => ({
  RebalanceSuggestion: ({ mode }: { mode?: PlacementMode }) => (
    <p>Suggestions in {mode ?? 'no'} mode</p>
  ),
}));

import { ApiError } from '../../api/client';
import { PlacementCard } from './PlacementCard';

const ALL_MODES: PlacementMode[] = ['observe', 'recommend', 'approve', 'auto'];

const RUN_BLOCKERS: PlacementSupportReason[] = [
  'not_cluster',
  'per_node_connections',
  'slot_stats_off',
  'not_dialed',
  'provider_managed',
  'server_version',
  'copy_only',
  'command_unavailable',
  'acl',
  'flag_off',
  'memory_storage',
];

function support(issues: PlacementSupportIssue[]): PlacementStatus['support'] {
  const blockers: Record<PlacementMode, PlacementSupportReason[]> = {
    observe: [],
    recommend: RUN_BLOCKERS.slice(0, 4),
    approve: RUN_BLOCKERS,
    auto: [...RUN_BLOCKERS, 'no_sign_in'],
  };
  const modes = Object.fromEntries(
    ALL_MODES.map((mode) => {
      const blocking = issues.find((issue) => blockers[mode].includes(issue.reason));
      return [mode, { available: !blocking, blockedBy: blocking?.reason ?? null }];
    }),
  ) as PlacementStatus['support']['modes'];
  return { issues, modes };
}

const FLAG_OFF: PlacementSupportIssue = {
  reason: 'flag_off',
  detail: 'Running slot moves is off on this install (BETTERDB_SLOT_MIGRATION).',
};

function balance(overrides: Partial<PlacementBalance> = {}): PlacementBalance {
  return {
    sampledAt: 1_000,
    settling: false,
    medianCpuUsecPerSecond: 300_000,
    triggerRatio: 2,
    resolveRatio: 1.25,
    shards: [
      {
        shardId: 'a1',
        address: '10.0.0.1:6379',
        slotCount: 5461,
        cpuUsecPerSecond: 930_000,
        cpuShare: 0.61,
        networkShare: 0.5,
        ratio: 3.1,
        overTrigger: true,
      },
      {
        shardId: 'b2',
        address: '10.0.0.2:6379',
        slotCount: 5461,
        cpuUsecPerSecond: 300_000,
        cpuShare: 0.2,
        networkShare: 0.25,
        ratio: 1,
        overTrigger: false,
      },
      {
        shardId: 'c3',
        address: '10.0.0.3:6379',
        slotCount: 0,
        cpuUsecPerSecond: 0,
        cpuShare: null,
        networkShare: null,
        ratio: null,
        overTrigger: false,
      },
    ],
    ...overrides,
  };
}

function status(overrides: Partial<PlacementStatus> = {}): PlacementStatus {
  return {
    connectionId: 'conn-1',
    mode: 'recommend',
    effectiveMode: 'recommend',
    selectableModes: ['observe', 'recommend'],
    support: support([FLAG_OFF]),
    balance: balance(),
    ...overrides,
  };
}

async function show(
  placement: PlacementStatus | Error,
  connectionId: string | undefined = 'conn-1',
) {
  if (placement instanceof Error) get.mockRejectedValue(placement);
  else get.mockResolvedValue(placement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlacementCard connectionId={connectionId} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await client.invalidateQueries();
  });
}

const card = () => screen.findByRole('region', { name: 'Slot placement' });
const modeButton = (region: HTMLElement, name: string) =>
  within(within(region).getByRole('group', { name: 'Placement mode' })).getByRole('button', {
    name: new RegExp(`^${name}`),
  });

describe('PlacementCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canMutate.mockReturnValue(true);
    license.licensed = true;
  });

  it('marks the stored mode and offers only the selectable ones', async () => {
    await show(status());

    const region = await card();
    expect(modeButton(region, 'Recommend')).toHaveAttribute('aria-pressed', 'true');
    expect(modeButton(region, 'Observe')).toHaveAttribute('aria-pressed', 'false');
    expect(modeButton(region, 'Observe')).toBeEnabled();
    expect(modeButton(region, 'Approve')).toBeDisabled();
    expect(modeButton(region, 'Auto')).toBeDisabled();
    expect(region).toHaveTextContent('Approve and Auto come in a later release.');
  });

  it('saves a new mode on the cluster', async () => {
    setMode.mockResolvedValue(status({ mode: 'observe', effectiveMode: 'observe' }));
    await show(status());

    const region = await card();
    fireEvent.click(modeButton(region, 'Observe'));

    await waitFor(() => expect(setMode).toHaveBeenCalledWith('conn-1', 'observe'));
    await waitFor(() =>
      expect(modeButton(region, 'Observe')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByText('Suggestions in observe mode')).toBeInTheDocument();
  });

  it('shows why a mode was refused', async () => {
    setMode.mockRejectedValue(
      new ApiError('Per-slot load is not collected.', 400, { blockedBy: 'slot_stats_off' }),
    );
    await show(status({ mode: 'observe', effectiveMode: 'observe' }));

    const region = await card();
    fireEvent.click(modeButton(region, 'Recommend'));

    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'Per-slot load is not collected.',
    );
  });

  it('lets only admins change the mode', async () => {
    canMutate.mockReturnValue(false);
    await show(status());

    const region = await card();
    for (const name of ['Observe', 'Recommend', 'Approve', 'Auto']) {
      expect(modeButton(region, name)).toBeDisabled();
    }
  });

  it('names the highest supported mode and every reason it stops there', async () => {
    const memory: PlacementSupportIssue = {
      reason: 'memory_storage',
      detail: 'Running slot moves needs durable storage (sqlite, turso or postgres).',
    };
    await show(status({ support: support([FLAG_OFF, memory]) }));

    const region = await card();
    expect(within(region).getByText('Supports up to Recommend')).toBeInTheDocument();
    const reasons = within(within(region).getByRole('list', { name: 'What limits placement' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(reasons).toEqual([FLAG_OFF.detail, memory.detail]);
  });

  it('says when the stored mode cannot run and what runs instead', async () => {
    const slotStats: PlacementSupportIssue = {
      reason: 'slot_stats_off',
      detail: 'Per-slot load is not collected (CLUSTER SLOT-STATS is off or unavailable).',
    };
    await show(
      status({
        effectiveMode: 'observe',
        selectableModes: ['observe'],
        support: support([slotStats, FLAG_OFF]),
      }),
    );

    const region = await card();
    expect(within(region).getByText('Supports up to Observe')).toBeInTheDocument();
    expect(region).toHaveTextContent(
      `Recommend is set, but this cluster runs as Observe: ${slotStats.detail}`,
    );
    expect(screen.getByText('Suggestions in observe mode')).toBeInTheDocument();
  });

  it('draws each shard against the median and marks the ones over the trigger', async () => {
    await show(status());

    const region = await card();
    const bars = within(region).getByRole('list', { name: 'Load against the median' });
    const rows = within(bars).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('10.0.0.1:6379'),
      expect.stringContaining('10.0.0.2:6379'),
      expect.stringContaining('10.0.0.3:6379'),
    ]);
    expect(rows[0]).toHaveTextContent('3.1x the median');
    expect(rows[0]).toHaveTextContent('Over the trigger');
    expect(rows[1]).toHaveTextContent('1x the median');
    expect(rows[1]).not.toHaveTextContent('Over the trigger');
    expect(rows[2]).toHaveTextContent('No slots');
    expect(region).toHaveTextContent(
      'A shard over 2x the median load is a hot shard; it counts as fixed below 1.25x.',
    );
  });

  it('says when the load is settling after slots moved', async () => {
    await show(status({ balance: balance({ settling: true }) }));

    expect(await card()).toHaveTextContent(
      'Slots changed owner and the load is still being measured.',
    );
  });

  it('says when no load has been sampled yet', async () => {
    await show(status({ balance: null }));

    expect(await card()).toHaveTextContent('No per-slot load sampled yet.');
  });

  it('shows the suggestions in the mode the cluster runs in', async () => {
    await show(status());

    await card();
    expect(screen.getByText('Suggestions in recommend mode')).toBeInTheDocument();
  });

  it('renders nothing without the license or a connection', async () => {
    license.licensed = false;
    await show(status());
    expect(screen.queryByRole('region', { name: 'Slot placement' })).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('says when the placement could not be read', async () => {
    await show(new ApiError('boom', 500));

    expect(await card()).toHaveTextContent('Could not read the placement status.');
  });
});
