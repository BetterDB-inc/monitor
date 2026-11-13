import type { SlotLoadRate } from '@app/cluster/shard-load';
import {
  DEFAULT_REBALANCE_POLICY,
  type RebalancePlan,
  type RebalanceShard,
  type RebalanceVerdict,
  describeNoPlan,
  planRebalance,
} from '../rebalance-planner';

const ZONE_BY_ID: Record<string, number> = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };

function shard(shardId: string, cpu: number, extra: Partial<RebalanceShard> = {}): RebalanceShard {
  return {
    shardId,
    nodeAddr: `10.0.0.${ZONE_BY_ID[shardId]}:6379`,
    cpuUsecPerSecond: cpu,
    slotCount: 100,
    state: 'healthy',
    hot: shardId === 'a',
    ...extra,
  };
}

function slots(start: number, cpus: number[], keyCount = 10): SlotLoadRate[] {
  return cpus.map((cpu, i) => ({
    slot: start + i,
    cpuUsecPerSecond: cpu,
    networkBytesInPerSecond: 0,
    networkBytesOutPerSecond: 0,
    keyCount,
  }));
}

function even(count: number, cpu: number): number[] {
  return new Array(count).fill(cpu);
}

function planOf(verdict: RebalanceVerdict): RebalancePlan {
  if (verdict.kind !== 'plan') throw new Error(`no plan: ${verdict.reason}`);
  return verdict;
}

function after(plan: RebalancePlan, shardId: string) {
  const row = plan.projection.find((shard) => shard.shardId === shardId);
  if (!row) throw new Error(`no projection for ${shardId}`);
  return row.after;
}

function movedSlots(plan: RebalancePlan): number[] {
  return plan.moves.flatMap((move) =>
    move.ranges.flatMap(([start, end]) =>
      Array.from({ length: end - start + 1 }, (_, i) => start + i),
    ),
  );
}

describe('planRebalance', () => {
  it('moves the cheapest run of slots off a broadly hot shard to the coldest shard', () => {
    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000)],
      slots: slots(0, even(100, 3_000)),
    });

    const plan = planOf(verdict);
    expect(plan).toMatchObject({
      kind: 'plan',
      action: 'spread',
      effect: 'resolves',
      sourceShardId: 'a',
      pinnedSlots: [],
      medianBefore: 100_000,
      medianAfter: 178_000,
    });
    expect(plan.moves).toEqual([
      {
        targetShardId: 'b',
        targetAddr: '10.0.0.2:6379',
        ranges: [[0, 25]],
        slotCount: 26,
        keyCount: 260,
        cpuUsecPerSecond: 78_000,
        shareOfShard: expect.closeTo(0.26),
      },
    ]);
    expect(plan.projection).toEqual([
      {
        shardId: 'a',
        nodeAddr: '10.0.0.1:6379',
        role: 'source',
        before: { cpuUsecPerSecond: 300_000, share: 0.6, ratio: 3 },
        after: {
          cpuUsecPerSecond: 222_000,
          share: expect.closeTo(0.444),
          ratio: expect.closeTo(222 / 178),
        },
      },
      {
        shardId: 'b',
        nodeAddr: '10.0.0.2:6379',
        role: 'target',
        before: { cpuUsecPerSecond: 100_000, share: 0.2, ratio: 1 },
        after: { cpuUsecPerSecond: 178_000, share: expect.closeTo(0.356), ratio: 1 },
      },
      {
        shardId: 'c',
        nodeAddr: '10.0.0.3:6379',
        role: 'other',
        before: { cpuUsecPerSecond: 100_000, share: 0.2, ratio: 1 },
        after: {
          cpuUsecPerSecond: 100_000,
          share: 0.2,
          ratio: expect.closeTo(100 / 178),
        },
      },
    ]);
  });

  it('prefers the run with the fewest keys', () => {
    const load = [...slots(0, even(50, 3_000), 100), ...slots(50, even(50, 3_000), 1)];

    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000)],
        slots: load,
      }),
    );

    expect(plan.moves[0].ranges).toEqual([[50, 75]]);
    expect(plan.moves[0].keyCount).toBe(26);
  });

  it('leaves a hot slot where it is and moves the cold slots around it', () => {
    const load = [
      ...slots(0, even(50, 2_000)),
      ...slots(50, [200_000]),
      ...slots(51, even(49, 2_000)),
    ];

    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [shard('a', 398_000), shard('b', 100_000), shard('c', 100_000)],
        slots: load,
      }),
    );

    expect(plan.effect).toBe('resolves');
    expect(plan.pinnedSlots).toEqual([{ slot: 50, shareOfShard: expect.closeTo(200 / 398) }]);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].ranges).toEqual([
      [0, 49],
      [51, 61],
    ]);
    expect(movedSlots(plan)).not.toContain(50);
    expect(after(plan, 'a').ratio).toBeLessThanOrEqual(DEFAULT_REBALANCE_POLICY.resolveRatio);
  });

  it('offers headroom when a hot slot keeps the shard hot but a quarter of its load can move', () => {
    const load = [
      ...slots(0, even(50, 3_000)),
      ...slots(50, [600_000]),
      ...slots(51, even(49, 3_000)),
    ];

    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [shard('a', 897_000), shard('b', 100_000), shard('c', 100_000)],
        slots: load,
      }),
    );

    expect(plan.effect).toBe('headroom');
    expect(plan.moves.map((move) => [move.targetShardId, move.ranges])).toEqual([
      ['b', [[0, 49]]],
      ['c', [[51, 99]]],
    ]);
    expect(after(plan, 'a').cpuUsecPerSecond).toBe(600_000);
    expect(after(plan, 'a').ratio).toBeGreaterThan(DEFAULT_REBALANCE_POLICY.resolveRatio);
  });

  it('plans nothing when one slot alone is more than a node can carry', () => {
    const load = [
      ...slots(0, even(50, 1_000)),
      ...slots(50, [900_000]),
      ...slots(51, even(49, 1_000)),
    ];

    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 999_000), shard('b', 100_000), shard('c', 100_000)],
      slots: load,
    });

    expect(verdict).toEqual({
      kind: 'no_plan',
      action: 'spread',
      reason: 'key_level',
      pinnedSlots: [{ slot: 50, shareOfShard: expect.closeTo(900 / 999) }],
    });
  });

  it('plans nothing when the slots that can move are under a quarter of the load', () => {
    const load = [...slots(0, even(50, 500)), ...slots(50, [500_000]), ...slots(51, even(49, 500))];

    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 549_500), shard('b', 100_000), shard('c', 100_000)],
      slots: load,
    });

    expect(verdict).toMatchObject({ kind: 'no_plan', reason: 'key_level' });
  });

  it('plans nothing when the other shards have no room', () => {
    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 1_500_000), shard('b', 720_000), shard('c', 720_000)],
      slots: slots(0, even(100, 15_000)),
    });

    expect(verdict).toEqual({
      kind: 'no_plan',
      action: 'spread',
      reason: 'cluster_hot',
      pinnedSlots: [],
    });
  });

  it('plans nothing when every other shard is hot or excluded', () => {
    const input = {
      hotShardId: 'a',
      shards: [
        shard('a', 900_000),
        shard('b', 100_000),
        shard('c', 900_000, { hot: true }),
        shard('d', 100_000),
        shard('e', 100_000),
      ],
      slots: slots(0, even(100, 9_000)),
    };

    expect(
      planRebalance(input, { ...DEFAULT_REBALANCE_POLICY, excludedShardIds: ['b', 'd', 'e'] }),
    ).toMatchObject({ kind: 'no_plan', reason: 'no_target' });
  });

  it.each(['suspect', 'failed'] as const)('plans nothing while a primary is %s', (state) => {
    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000, { state })],
      slots: slots(0, even(100, 3_000)),
    });

    expect(verdict).toMatchObject({ kind: 'no_plan', reason: 'unhealthy_node' });
  });

  it('plans nothing without slot load or for a shard that is not hot', () => {
    const shards = [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000)];

    expect(planRebalance({ hotShardId: 'a', shards, slots: [] })).toMatchObject({
      kind: 'no_plan',
      reason: 'settling',
    });
    expect(
      planRebalance({ hotShardId: 'a', shards, slots: slots(0, even(100, 1_100)) }),
    ).toMatchObject({ kind: 'no_plan', reason: 'settling' });
    expect(
      planRebalance({ hotShardId: 'z', shards, slots: slots(0, even(100, 3_000)) }),
    ).toMatchObject({ kind: 'no_plan', reason: 'settling' });
  });

  it('uses as many targets as it takes when the median does not move', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: ids.map((id) => shard(id, id === 'a' ? 250_000 : 100_000)),
        slots: slots(0, even(100, 2_500)),
      }),
    );

    expect(plan.effect).toBe('resolves');
    expect(plan.moves.map((move) => [move.targetShardId, move.ranges])).toEqual([
      ['b', [[0, 11]]],
      ['c', [[12, 23]]],
      ['d', [[24, 35]]],
    ]);
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(after(plan, id).ratio).toBeLessThanOrEqual(DEFAULT_REBALANCE_POLICY.resolveRatio);
    }
  });

  it('offers headroom when the allowed targets cannot take all of it', () => {
    const cpu: Record<string, number> = { a: 300_000, b: 50_000, c: 50_000 };

    const plan = planOf(
      planRebalance(
        {
          hotShardId: 'a',
          shards: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => shard(id, cpu[id] ?? 100_000)),
          slots: slots(0, even(100, 3_000)),
        },
        { ...DEFAULT_REBALANCE_POLICY, maxTargets: 2 },
      ),
    );

    expect(plan.effect).toBe('headroom');
    expect(plan.moves.map((move) => [move.targetShardId, move.ranges])).toEqual([
      ['b', [[0, 24]]],
      ['c', [[25, 49]]],
    ]);
    expect(after(plan, 'b').ratio).toBeCloseTo(1.25);
  });

  it('fills an empty primary first', () => {
    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [
          shard('a', 250_000),
          shard('b', 100_000),
          shard('c', 100_000),
          shard('e', 0, { slotCount: 0, hot: false }),
        ],
        slots: slots(0, even(100, 2_500)),
      }),
    );

    expect(plan.effect).toBe('resolves');
    expect(plan.moves.map((move) => move.targetShardId)).toEqual(['e']);
    expect(plan.medianBefore).toBe(100_000);
    expect(plan.projection.find((row) => row.shardId === 'e')?.before).toEqual({
      cpuUsecPerSecond: 0,
      share: 0,
      ratio: 0,
    });
  });

  it('breaks a tie between targets by the zone of the hot shard', () => {
    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [
          shard('a', 300_000, { availabilityZone: 'az-2' }),
          shard('b', 100_000, { availabilityZone: 'az-1' }),
          shard('c', 100_000, { availabilityZone: 'az-2' }),
        ],
        slots: slots(0, even(100, 3_000)),
      }),
    );

    expect(plan.moves.map((move) => move.targetShardId)).toEqual(['c']);
  });

  it('never moves an excluded slot', () => {
    const plan = planOf(
      planRebalance(
        {
          hotShardId: 'a',
          shards: [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000)],
          slots: slots(0, even(100, 3_000)),
        },
        { ...DEFAULT_REBALANCE_POLICY, excludedSlots: [0, 1, 2, 3, 4] },
      ),
    );

    expect(plan.moves[0].ranges).toEqual([[5, 30]]);
  });

  it('plans nothing when the slots are too scattered to move enough in a few ranges', () => {
    const scattered = even(100, 3_000).map((cpu, i) => slots(i * 2, [cpu])[0]);

    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000)],
      slots: scattered,
    });

    expect(verdict).toMatchObject({ kind: 'no_plan', reason: 'slots_scattered' });
  });

  it('keeps every number finite on a near-idle cluster', () => {
    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 900_000), shard('b', 0), shard('c', 0)],
      slots: slots(0, even(100, 9_000)),
    });

    const plan = planOf(verdict);
    expect(plan.effect).toBe('resolves');
    expect(plan.projection[0].before.ratio).toBe(18);
    expect(JSON.stringify(verdict)).not.toMatch(/null|NaN|Infinity/);
  });

  it('warns about the fork on the source and about a target with fewer replicas', () => {
    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [
          shard('a', 300_000, { replicaCount: 1 }),
          shard('b', 100_000, { replicaCount: 0 }),
          shard('c', 100_000, { replicaCount: 1 }),
        ],
        slots: slots(0, even(100, 3_000)),
      }),
    );

    expect(plan.warnings).toEqual([
      { code: 'source_fork', shardId: 'a' },
      { code: 'fewer_replicas', shardId: 'b' },
    ]);
  });
});

describe('describeNoPlan', () => {
  const noPlan = (
    reason: string,
    pinnedSlots: Array<{ slot: number; shareOfShard: number }> = [],
  ) => ({ kind: 'no_plan', action: 'spread', reason, pinnedSlots }) as RebalanceVerdict;

  it('says nothing about a plan', () => {
    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000)],
      slots: slots(0, even(100, 3_000)),
    });

    expect(describeNoPlan(verdict, [])).toBe('');
    expect(describeNoPlan(undefined, [])).toBe('');
  });

  it('names the slot and the key that carry the load', () => {
    const verdict = noPlan('key_level', [{ slot: 9189, shareOfShard: 0.81 }]);

    expect(
      describeNoPlan(verdict, [
        { key: 'other', slot: 12, freq: 255 },
        { key: 'session:global', slot: 9189, freq: 200 },
      ]),
    ).toBe(
      " Rebalancing will not help: slot 9189 alone is 81% of this shard's CPU. " +
        'Consider client-side caching, reads from replicas, or splitting key "session:global".',
    );
  });

  it('names several slots and no key when the keys are not known', () => {
    const verdict = noPlan('key_level', [
      { slot: 0, shareOfShard: 0.5 },
      { slot: 7, shareOfShard: 0.25 },
      { slot: 9, shareOfShard: 0.2 },
    ]);

    expect(describeNoPlan(verdict, [])).toBe(
      " Rebalancing will not help: slots 0, 7 and 9 are 95% of this shard's CPU. " +
        'Consider client-side caching, reads from replicas, or splitting the hot keys.',
    );
  });

  it.each([
    [
      'cluster_hot',
      ' Rebalancing will not help: no other shard has room for this load. Consider adding a shard.',
    ],
    ['no_target', ' No rebalance is suggested: no other primary can take slots.'],
    ['unhealthy_node', ' No rebalance is suggested while a primary is failed or suspect.'],
    ['migration_running', ' No rebalance is suggested while a slot migration is running.'],
    ['settling', ' No rebalance is suggested until the slot load settles.'],
    [
      'slots_scattered',
      " No rebalance is suggested: this shard's slots are too scattered to move enough load in a few ranges.",
    ],
  ])('explains %s', (reason, sentence) => {
    expect(describeNoPlan(noPlan(reason), [])).toBe(sentence);
  });
});
