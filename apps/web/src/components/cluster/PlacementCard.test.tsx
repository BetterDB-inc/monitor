import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DEFAULT_PLACEMENT_SETTINGS,
  type PlacementBalance,
  type PlacementMode,
  type PlacementStatus,
  type PlacementSupportIssue,
  type PlacementSupportReason,
} from '@betterdb/shared';

const { get, setMode, setPolicy, canMutate, license } = vi.hoisted(() => ({
  get: vi.fn(),
  setMode: vi.fn(),
  setPolicy: vi.fn(),
  canMutate: vi.fn(() => true),
  license: { licensed: true },
}));

vi.mock('../../api/placement', () => ({ placementApi: { get, setMode, setPolicy } }));
vi.mock('../../hooks/useCanMutate', () => ({ useCanMutate: canMutate }));
vi.mock('../../hooks/useLicense', () => ({
  useLicense: () => ({ license: null, hasFeature: () => license.licensed }),
}));
vi.mock('../anomalies/RebalanceSuggestion', () => ({
  RebalanceSuggestion: ({ mode, runnable }: { mode?: PlacementMode; runnable?: boolean }) => (
    <p>
      Suggestions in {mode ?? 'no'} mode{runnable === false ? ', not runnable' : ''}
    </p>
  ),
}));

import { ApiError } from '../../api/client';
import { PlacementCard } from './PlacementCard';

const ALL_MODES: PlacementMode[] = ['observe', 'recommend', 'approve', 'auto'];

const RUN_BLOCKERS: PlacementSupportReason[] = [
  'not_connected',
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
    recommend: RUN_BLOCKERS.slice(0, 5),
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
        sustainCpuUsecPerSecond: 900_000,
        sustainRatio: 3,
        baselineRatio: 1.5,
        trigger: 'over',
        warmUntil: null,
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
        sustainCpuUsecPerSecond: 300_000,
        sustainRatio: 1,
        baselineRatio: 1,
        trigger: 'short_history',
        warmUntil: new Date(2026, 10, 26, 14, 30).getTime(),
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
        sustainCpuUsecPerSecond: 0,
        sustainRatio: null,
        baselineRatio: null,
        trigger: 'short_history',
        warmUntil: null,
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
    settings: DEFAULT_PLACEMENT_SETTINGS,
    policyVersion: 3,
    policyInvalid: null,
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
  return client;
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

  it('warns that the stored policy is invalid and lists the problems', async () => {
    await show(
      status({
        policyInvalid: {
          problems: ['resolveRatio: must be under triggerRatio'],
          exclusionsReadable: true,
        },
      }),
    );

    const alert = within(await card()).getByRole('alert');
    expect(alert).toHaveTextContent('The stored placement policy is invalid.');
    expect(alert).toHaveTextContent('resolveRatio: must be under triggerRatio');
    expect(alert).toHaveTextContent('the exclusions are kept');
  });

  it('says no slot moves are suggested while the exclusions cannot be read', async () => {
    await show(
      status({
        policyInvalid: { problems: ['excludedSlots: expected array'], exclusionsReadable: false },
      }),
    );

    expect(within(await card()).getByRole('alert')).toHaveTextContent(
      'no slot moves are suggested until the policy is saved again',
    );
  });

  it('saves the policy from the drawer at the version it read', async () => {
    setPolicy.mockResolvedValue({
      ...status({ settings: { ...DEFAULT_PLACEMENT_SETTINGS, triggerRatio: 3 }, policyVersion: 4 }),
      exclusionsExpanded: true,
      exclusionsExpandProblem: null,
    });
    const client = await show(status());

    fireEvent.click(within(await card()).getByRole('button', { name: 'Edit policy' }));
    fireEvent.change(screen.getByLabelText('Trigger ratio'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(setPolicy).toHaveBeenCalledWith(
        'conn-1',
        { ...DEFAULT_PLACEMENT_SETTINGS, triggerRatio: 3 },
        3,
      ),
    );
    await waitFor(() =>
      expect(client.getQueryData<PlacementStatus>(['placement', 'conn-1'])?.policyVersion).toBe(4),
    );
    await waitFor(() => expect(screen.queryByLabelText('Trigger ratio')).not.toBeInTheDocument());
  });

  it('drops an open draft when the card switches to a cluster it already read', async () => {
    get.mockResolvedValue(status());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['placement', 'conn-2'], status({ policyVersion: 3 }));
    const at = (connectionId: string) => (
      <QueryClientProvider client={client}>
        <PlacementCard connectionId={connectionId} />
      </QueryClientProvider>
    );
    const { rerender } = render(at('conn-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit policy' }));
    fireEvent.change(screen.getByLabelText('Trigger ratio'), { target: { value: '3' } });

    rerender(at('conn-2'));

    expect(screen.queryByLabelText('Trigger ratio')).not.toBeInTheDocument();
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('lets a member view the policy without saving it', async () => {
    canMutate.mockReturnValue(false);
    await show(status());

    fireEvent.click(within(await card()).getByRole('button', { name: 'View policy' }));

    expect(screen.getByLabelText('Trigger ratio')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
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

  it('reads the hot-shard suggestions again after a new mode is saved', async () => {
    setMode.mockResolvedValue(status({ mode: 'observe', effectiveMode: 'observe' }));
    const client = await show(status());
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    fireEvent.click(modeButton(await card(), 'Observe'));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['open-hot-shards', 'conn-1'] }),
    );
  });

  it('keeps the saved mode when a read started before the save ends after it', async () => {
    get.mockResolvedValueOnce(status());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PlacementCard connectionId="conn-1" />
      </QueryClientProvider>,
    );
    const region = await card();
    await waitFor(() =>
      expect(modeButton(region, 'Recommend')).toHaveAttribute('aria-pressed', 'true'),
    );

    let finishRead: (value: PlacementStatus) => void = () => undefined;
    get.mockReturnValueOnce(
      new Promise<PlacementStatus>((resolve) => {
        finishRead = resolve;
      }),
    );
    void client.invalidateQueries();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    setMode.mockResolvedValue(status({ mode: 'observe', effectiveMode: 'observe' }));
    fireEvent.click(modeButton(region, 'Observe'));
    await waitFor(() =>
      expect(modeButton(region, 'Observe')).toHaveAttribute('aria-pressed', 'true'),
    );

    await act(async () => {
      finishRead(status());
    });
    await waitFor(() =>
      expect(client.getQueryState(['placement', 'conn-1'])?.fetchStatus).toBe('idle'),
    );

    expect(client.getQueryData<PlacementStatus>(['placement', 'conn-1'])?.mode).toBe('observe');
    expect(modeButton(region, 'Observe')).toHaveAttribute('aria-pressed', 'true');
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
      'A shard over 2x the median load is a hot shard; a slot move aims to bring it under 1.25x. The trigger for slot moves fires only when the sustained load stays over 2x for 30 minutes.',
    );
  });

  describe('with the clock on the day the warm-up ends or the day before', () => {
    const warmEnd = new Date(2026, 10, 26, 14, 30);
    const time = warmEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const day = warmEnd.toLocaleDateString([], { month: 'short', day: 'numeric' });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the sustained load of each shard, and when a short history is long enough', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 26, 9, 0) });
      await show(status());

      const bars = within(await card()).getByRole('list', { name: 'Load against the median' });
      const rows = within(bars).getAllByRole('listitem');
      expect(rows[0]).toHaveTextContent('Sustained');
      expect(rows[0]).toHaveTextContent('Sustained 3x the median, 1.5x over 6 hours');
      expect(rows[1]).toHaveTextContent(`Warming up until ${time}`);
      expect(rows[1]).not.toHaveTextContent(day);
      expect(rows[2]).not.toHaveTextContent('Sustained');
    });

    it('names the day when a warm-up ends on another day', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 25, 23, 0) });
      await show(status());

      const bars = within(await card()).getByRole('list', { name: 'Load against the median' });
      const rows = within(bars).getAllByRole('listitem');
      expect(rows[1]).toHaveTextContent(`Warming up until ${day}, ${time}`);
    });
  });

  it('shows a shard with no load history yet as warming up', async () => {
    const shards = balance().shards.map((shard) =>
      shard.shardId === 'b2' ? { ...shard, warmUntil: null } : shard,
    );
    await show(status({ balance: balance({ shards }) }));

    const bars = within(await card()).getByRole('list', { name: 'Load against the median' });
    const rows = within(bars).getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('Warming up');
    expect(rows[1]).not.toHaveTextContent('Warming up until');
    expect(rows[1]).not.toHaveTextContent('Sustained');
  });

  it('names the CPU share limit in the trigger sentence when one is set', async () => {
    const base = status();
    await show(status({ settings: { ...base.settings, maxCpuShare: 0.4 } }));

    expect(await card()).toHaveTextContent(
      'The trigger for slot moves fires only when the sustained load stays over 2x, or above 40% of the cluster CPU, for 30 minutes.',
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

  it('keeps the suggestions but not the run button after a refresh fails', async () => {
    const client = await show(status());
    await card();
    expect(screen.getByText('Suggestions in recommend mode')).toBeInTheDocument();

    get.mockRejectedValue(new ApiError('boom', 500));
    await act(async () => {
      await client.invalidateQueries();
    });

    expect(
      await screen.findByText('Suggestions in recommend mode, not runnable', undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
  });

  it('renders nothing without the license or a connection', async () => {
    license.licensed = false;
    await show(status());
    expect(screen.queryByRole('region', { name: 'Slot placement' })).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('says it is reading the placement until the first read ends', async () => {
    get.mockReturnValue(new Promise(() => undefined));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PlacementCard connectionId="conn-1" />
      </QueryClientProvider>,
    );

    expect(await card()).toHaveTextContent('Reading the placement status');
  });

  it('says when the placement could not be read', async () => {
    await show(new ApiError('boom', 500));

    expect(await card()).toHaveTextContent('Could not read the placement status.');
  });
});
