import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  HotShardDetail,
  RebalanceNoPlanReason,
  RebalancePlan,
  RebalanceVerdict,
} from '../../types/anomaly';

const { getAnomalyEvents, getHotShards, copyToClipboard } = vi.hoisted(() => ({
  getAnomalyEvents: vi.fn(),
  getHotShards: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock('../../api/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/metrics')>();
  return { ...actual, metricsApi: { getAnomalyEvents, getHotShards } };
});
vi.mock('../../lib/clipboard', () => ({ copyToClipboard }));

import { RebalanceSuggestion } from './RebalanceSuggestion';

const EVENT = { id: 'evt-1', metricType: 'hot_shard', resolved: false };
const SOURCE = '3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d';
const TARGET = '9c4e1b7a2d5f8036a1c3e5f7092b4d6f8a0c2e4b';
const OTHER = '5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';
const MIGRATESLOTS = `CLUSTER MIGRATESLOTS SLOTSRANGE 2000 2410 NODE ${TARGET}`;

function plan(overrides: Partial<RebalancePlan> = {}): RebalancePlan {
  return {
    kind: 'plan',
    action: 'spread',
    effect: 'resolves',
    sourceShardId: SOURCE,
    moves: [
      {
        targetShardId: TARGET,
        targetAddr: '10.0.0.3:6379',
        ranges: [[2000, 2410]],
        slotCount: 411,
        keyCount: 48_210,
        cpuUsecPerSecond: 262_000,
        shareOfShard: 0.28,
      },
    ],
    pinnedSlots: [],
    projection: [
      {
        shardId: SOURCE,
        nodeAddr: '10.0.0.1:6379',
        role: 'source',
        before: { cpuUsecPerSecond: 930_000, share: 0.61, ratio: 3.1 },
        after: { cpuUsecPerSecond: 668_000, share: 0.44, ratio: 1.19 },
      },
      {
        shardId: TARGET,
        nodeAddr: '10.0.0.3:6379',
        role: 'target',
        before: { cpuUsecPerSecond: 300_000, share: 0.2, ratio: 1 },
        after: { cpuUsecPerSecond: 562_000, share: 0.37, ratio: 1 },
      },
      {
        shardId: OTHER,
        nodeAddr: '10.0.0.2:6379',
        role: 'other',
        before: { cpuUsecPerSecond: 290_000, share: 0.19, ratio: 0.97 },
        after: { cpuUsecPerSecond: 290_000, share: 0.19, ratio: 0.52 },
      },
    ],
    medianBefore: 300_000,
    medianAfter: 562_000,
    warnings: [{ code: 'source_fork', shardId: SOURCE }],
    support: 'valkey_atomic',
    commands: [{ nodeAddr: '10.0.0.1:6379', text: MIGRATESLOTS }],
    ...overrides,
  };
}

function noPlan(reason: RebalanceNoPlanReason, pinnedSlots = [] as RebalancePlan['pinnedSlots']) {
  return { kind: 'no_plan', action: 'spread', reason, pinnedSlots } as const;
}

function hotShard(
  rebalance: RebalanceVerdict | undefined,
  overrides: Partial<HotShardDetail> = {},
): HotShardDetail {
  return {
    eventId: 'evt-1',
    captureAvailable: false,
    shardId: SOURCE,
    nodeAddr: '10.0.0.1:6379',
    slotCount: 5461,
    since: 1_000,
    sampledAt: 61_000,
    cpu: { perSecond: 930_000, share: 0.61, median: 300_000, ratio: 3.1 },
    network: { perSecond: 0, share: 0, median: 0 },
    topSlots: [],
    topKeys: [],
    keySource: 'unavailable',
    keysSampled: 0,
    rebalance,
    ...overrides,
  };
}

async function show(
  hotShards: HotShardDetail[] | Error,
  { events = [EVENT] as unknown[], connected = true } = {},
): Promise<void> {
  getAnomalyEvents.mockResolvedValue(events);
  if (hotShards instanceof Error) getHotShards.mockRejectedValue(hotShards);
  else getHotShards.mockResolvedValue(hotShards);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RebalanceSuggestion connectionId={connected ? 'conn-1' : undefined} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await client.invalidateQueries();
  });
}

const panel = () => screen.findByRole('region', { name: /hot shard 3f2a9c1e/i });

describe('RebalanceSuggestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyToClipboard.mockResolvedValue(true);
  });

  it('says which slots to move and where', async () => {
    await show([hotShard(plan())]);

    const region = await panel();
    expect(region).toHaveTextContent('Suggested rebalance for hot shard 3f2a9c1e at 10.0.0.1:6379');
    expect(region).toHaveTextContent(
      "Move slots 2000-2410 (411 slots, 28% of this shard's CPU, about 48k keys) to shard 9c4e1b7a at 10.0.0.3:6379.",
    );
  });

  it('labels a plan that brings the shard back under the line', async () => {
    await show([hotShard(plan())]);

    const region = await panel();
    expect(within(region).getByText('Resolves')).toBeInTheDocument();
    expect(region).toHaveTextContent('This brings the shard from 3.1x to 1.19x the median.');
  });

  it('labels a plan that only frees room', async () => {
    const rows = plan().projection;
    rows[0] = { ...rows[0], after: { cpuUsecPerSecond: 668_000, share: 0.44, ratio: 2.2 } };
    await show([hotShard(plan({ effect: 'headroom', projection: rows }))]);

    const region = await panel();
    expect(within(region).getByText('Headroom')).toBeInTheDocument();
    expect(region).toHaveTextContent(
      "This frees 28% of the shard's CPU. The shard stays at 2.2x the median, but the load that stays has more of the node to itself.",
    );
  });

  it('writes one slot as a slot and lists several ranges', async () => {
    const move = plan().moves[0];
    await show([
      hotShard(
        plan({
          moves: [
            {
              ...move,
              ranges: [
                [7, 7],
                [100, 180],
              ],
              slotCount: 82,
              keyCount: 950,
            },
          ],
        }),
      ),
    ]);

    expect(await panel()).toHaveTextContent(
      "Move slots 7 and 100-180 (82 slots, 28% of this shard's CPU, about 950 keys) to shard",
    );
  });

  it('shows the load of the hot shard and its targets before and after', async () => {
    await show([hotShard(plan())]);

    const table = within(await panel()).getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('3f2a9c1e');
    expect(rows[1]).toHaveTextContent('Hot shard');
    expect(rows[1]).toHaveTextContent('93% → 67%');
    expect(rows[1]).toHaveTextContent('61% → 44%');
    expect(rows[1]).toHaveTextContent('3.1x → 1.19x');
    expect(rows[2]).toHaveTextContent('9c4e1b7a');
    expect(rows[2]).toHaveTextContent('Target');
    expect(rows[2]).toHaveTextContent('30% → 56%');
    expect(await panel()).toHaveTextContent(
      'The 1 other shard keeps its load. The median goes from 30% to 56% of a core.',
    );
  });

  it('names the slots that stay', async () => {
    await show([
      hotShard(
        plan({
          pinnedSlots: [
            { slot: 1234, shareOfShard: 0.62 },
            { slot: 90, shareOfShard: 0.07 },
          ],
        }),
      ),
    ]);

    expect(await panel()).toHaveTextContent(
      "Not moved: slot 1234 (62% of this shard's CPU) and slot 90 (7%).",
    );
  });

  it('lists every warning in plain words', async () => {
    await show([
      hotShard(
        plan({
          warnings: [
            { code: 'source_fork', shardId: SOURCE },
            { code: 'fewer_replicas', shardId: TARGET },
            { code: 'target_memory', shardId: TARGET, memoryShare: 0.874 },
            { code: 'memory_unknown', shardId: TARGET },
          ],
        }),
      ),
    ]);

    const items = within(within(await panel()).getByRole('list', { name: 'Warnings' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'The hot shard forks to send the slots, while it is the busiest node.',
      'Shard 9c4e1b7a has fewer replicas than the hot shard.',
      'Shard 9c4e1b7a would be at about 87% of its memory limit after the move.',
      'The memory room of shard 9c4e1b7a is not known.',
    ]);
  });

  it('gives the Valkey command with the node to run it on, and copies it', async () => {
    await show([hotShard(plan())]);

    const region = await panel();
    expect(region).toHaveTextContent(
      'Run this on the hot shard (10.0.0.1:6379). The server starts all of the moves or none.',
    );
    expect(region).toHaveTextContent(MIGRATESLOTS);
    expect(region).toHaveTextContent('BetterDB does not run it.');

    fireEvent.click(within(region).getByRole('button', { name: 'Copy command' }));

    expect(copyToClipboard).toHaveBeenCalledWith(MIGRATESLOTS);
    expect(await within(region).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('gives one Redis command per target', async () => {
    await show([
      hotShard(
        plan({
          support: 'redis_atomic',
          commands: [
            { nodeAddr: '10.0.0.3:6379', text: 'CLUSTER MIGRATION IMPORT 2000 2200' },
            { nodeAddr: '10.0.0.4:6379', text: 'CLUSTER MIGRATION IMPORT 2201 2410' },
          ],
        }),
      ),
    ]);

    const region = await panel();
    expect(region).toHaveTextContent('Run each command on its target shard.');
    expect(region).toHaveTextContent('On 10.0.0.3:6379');
    expect(region).toHaveTextContent('On 10.0.0.4:6379');

    fireEvent.click(within(region).getAllByRole('button', { name: 'Copy command' })[1]);

    expect(copyToClipboard).toHaveBeenCalledWith('CLUSTER MIGRATION IMPORT 2201 2410');
  });

  it.each([
    [
      'none',
      'This server version has no single command that moves slots: that needs Valkey 9.0 or Redis 8.4 on every shard of the plan.',
    ],
    [
      'provider_managed',
      "Slot commands are not supported on this managed service. Use your provider's resharding with the slots above.",
    ],
    ['unknown', 'The server version could not be read, so no command is shown.'],
    [undefined, 'The server version could not be read, so no command is shown.'],
  ] as const)('explains why there is no command when support is %s', async (support, text) => {
    await show([hotShard(plan({ support, commands: [] }))]);

    const region = await panel();
    expect(region).toHaveTextContent(text);
    expect(within(region).queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();
  });

  it('says a single slot is the load and names its key', async () => {
    await show([
      hotShard(noPlan('key_level', [{ slot: 9189, shareOfShard: 0.81 }]), {
        topKeys: [
          { key: 'cart:{7}', slot: 12, freq: 250 },
          { key: 'session:global', slot: 9189, freq: 255 },
        ],
      }),
    ]);

    const region = await panel();
    expect(within(region).getByText('No plan')).toBeInTheDocument();
    expect(region).toHaveTextContent(
      'Rebalancing will not help: slot 9189 alone is 81% of this shard\'s CPU. Its hottest key is "session:global".',
    );
    const options = within(within(region).getByRole('list', { name: 'What can help' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(options).toEqual([
      'Client-side caching for the hot keys.',
      'Reads from replicas.',
      'Splitting the hot key into several keys.',
    ]);
    expect(within(region).queryByRole('table')).not.toBeInTheDocument();
  });

  it('says several slots are the load when no single one is', async () => {
    await show([
      hotShard(
        noPlan('key_level', [
          { slot: 5, shareOfShard: 0.45 },
          { slot: 9, shareOfShard: 0.41 },
        ]),
      ),
    ]);

    expect(await panel()).toHaveTextContent(
      "Rebalancing will not help: slots 5 and 9 are 86% of this shard's CPU.",
    );
  });

  it('says the load is at the key level when no slot stands out', async () => {
    await show([hotShard(noPlan('key_level'))]);

    expect(await panel()).toHaveTextContent(
      "Rebalancing will not help: the slots that can move carry too little of this shard's CPU.",
    );
  });

  it.each([
    ['cluster_hot', 'No other shard has room for this load. Consider adding a shard.'],
    [
      'too_many_targets',
      'This load would have to be spread over too many shards for one suggestion.',
    ],
    ['no_target', 'No other primary can take slots.'],
    [
      'unhealthy_node',
      'A primary is failed or suspect. A suggestion comes back when every primary is healthy.',
    ],
    [
      'migration_running',
      'A slot migration is running, or the monitor could not ask every primary whether one is. A suggestion comes back when no migration is running and every primary answers.',
    ],
    ['settling', 'Slots changed owner and the load is still being measured.'],
    [
      'slots_scattered',
      "This shard's slots are too scattered to move enough load in a few ranges.",
    ],
  ] as const)('gives one plain reason for %s', async (reason, text) => {
    await show([hotShard(noPlan(reason))]);

    const region = await panel();
    expect(within(region).getByText('No plan')).toBeInTheDocument();
    expect(region).toHaveTextContent(text);
  });

  it('shows one panel per open hot shard', async () => {
    await show(
      [
        hotShard(plan()),
        hotShard(noPlan('settling'), {
          eventId: 'evt-2',
          shardId: OTHER,
          nodeAddr: '10.0.0.2:6379',
        }),
      ],
      { events: [EVENT, { ...EVENT, id: 'evt-2' }] },
    );

    expect(await screen.findAllByRole('region')).toHaveLength(2);
  });

  it('shows nothing for a shard whose suggestion is not computed yet', async () => {
    await show([hotShard(undefined)]);

    await waitFor(() => expect(getHotShards).toHaveBeenCalled());
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows nothing for a shard whose event is no longer open', async () => {
    await show([hotShard(plan(), { eventId: 'evt-old' })]);

    await waitFor(() => expect(getHotShards).toHaveBeenCalled());
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('asks for nothing when no hot shard is open', async () => {
    await show([hotShard(plan())], { events: [] });

    await waitFor(() => expect(getAnomalyEvents).toHaveBeenCalled());
    expect(getHotShards).not.toHaveBeenCalled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows nothing when the hot shards cannot be read', async () => {
    await show(new Error('boom'));

    await waitFor(() => expect(getHotShards).toHaveBeenCalled());
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows nothing without a connection', async () => {
    await show([hotShard(plan())], { connected: false });

    expect(getAnomalyEvents).not.toHaveBeenCalled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
