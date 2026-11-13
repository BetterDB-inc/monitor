import type { SlotLoadRate } from '@app/cluster/shard-load';
import {
  DEFAULT_REBALANCE_POLICY,
  type RebalancePlan,
  type RebalanceShard,
  type RebalanceVerdict,
  describeNoPlan,
  memoryWarnings,
  planRebalance,
  planRebalances,
  shardMemoryFromInfo,
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

function fleet(count: number, cpu: number): RebalanceShard[] {
  return Array.from({ length: count }, (_, i) => ({
    shardId: `s${String(i + 1).padStart(2, '0')}`,
    nodeAddr: `10.0.1.${i + 1}:6379`,
    cpuUsecPerSecond: cpu,
    slotCount: 100,
    state: 'healthy' as const,
    hot: false,
  }));
}

function expectTargetsToFit(plan: RebalancePlan, policy = DEFAULT_REBALANCE_POLICY): void {
  for (const row of plan.projection.filter((shard) => shard.role === 'target')) {
    expect(row.after.ratio).toBeLessThanOrEqual(policy.resolveRatio + 1e-9);
    expect(row.after.cpuUsecPerSecond).toBeLessThanOrEqual(policy.nodeCpuLimitUsecPerSecond);
  }
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

  it.each(['suspect', 'failed'] as const)(
    'plans around a %s primary that owns no slots',
    (state) => {
      const plan = planOf(
        planRebalance({
          hotShardId: 'a',
          shards: [
            shard('a', 300_000),
            shard('b', 100_000),
            shard('c', 100_000),
            shard('e', 0, { slotCount: 0, state }),
          ],
          slots: slots(0, even(100, 3_000)),
        }),
      );

      expect(plan.moves.map((move) => move.targetShardId)).not.toContain('e');
    },
  );

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

  it('keeps a slot that no target can take out of the plan', () => {
    const cpus = even(200, 2_000);
    cpus[100] = 95_000;
    const load = slots(0, cpus, 500);
    load[100] = { ...load[100], keyCount: 1 };

    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [shard('a', 493_000), ...fleet(8, 100_000)],
        slots: load,
      }),
    );

    expect(plan.effect).toBe('resolves');
    expect(movedSlots(plan)).not.toContain(100);
    expect(plan.pinnedSlots).toEqual([{ slot: 100, shareOfShard: expect.closeTo(95 / 493) }]);
    expect(plan.moves).toHaveLength(4);
    expect(after(plan, 'a').ratio).toBeLessThanOrEqual(DEFAULT_REBALANCE_POLICY.resolveRatio);
    expectTargetsToFit(plan);
  });

  it('keeps a plan that fits even when a slot is heavier than an even share', () => {
    const load = [
      ...slots(0, [24_000, 18_000, 18_000]),
      ...[4, 6, 8, 10, 12].flatMap((slot) => slots(slot, [25_000])),
    ];

    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [shard('a', 185_000), ...fleet(8, 100_000)],
        slots: load,
      }),
    );

    expect(plan.effect).toBe('resolves');
    expect(plan.pinnedSlots).toEqual([]);
    expect(plan.moves.map((move) => move.ranges)).toEqual([[[0, 0]], [[1, 1]], [[2, 2]]]);
    expect(after(plan, 'a').cpuUsecPerSecond).toBe(125_000);
    expectTargetsToFit(plan);
  });

  it('keeps headroom that fits even when a slot is heavier than an even share', () => {
    const loads = [40_000, 30_000, 12_000, 22_000, 27_000, 48_000, 37_000, 17_000];

    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [
          shard('a', 100_000),
          ...fleet(8, 0).map((target, i) => ({ ...target, cpuUsecPerSecond: loads[i] })),
        ],
        slots: slots(1, [30_000, 45_000, 14_000, 11_000]),
      }),
    );

    expect(plan.effect).toBe('headroom');
    expect(plan.pinnedSlots.map((pinned) => pinned.slot)).toEqual([2, 1]);
    expect(plan.moves.map((move) => [move.targetShardId, move.ranges])).toEqual([
      ['s03', [[3, 3]]],
      ['s08', [[4, 4]]],
    ]);
    expectTargetsToFit(plan);
  });

  it.each([1, 2, 3])('never plans more ranges than the limit of %i', (maxRanges) => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    const verdict = planRebalance(
      {
        hotShardId: 'a',
        shards: ids.map((id) => shard(id, id === 'a' ? 250_000 : 100_000)),
        slots: slots(0, even(100, 2_500)),
      },
      { ...DEFAULT_REBALANCE_POLICY, maxRanges },
    );

    if (maxRanges < 3) {
      expect(verdict).toMatchObject({ kind: 'no_plan', reason: 'too_many_targets' });
      return;
    }
    expect(planOf(verdict).moves.flatMap((move) => move.ranges)).toHaveLength(3);
  });

  it('gives every planned target its share, so a plan that resolves is labelled so', () => {
    const plan = planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [shard('a', 500_000), ...fleet(8, 100_000)],
        slots: slots(0, even(800, 625)),
      }),
    );

    expect(plan.effect).toBe('resolves');
    expect(plan.moves).toHaveLength(4);
    expect(after(plan, 'a').ratio).toBeLessThanOrEqual(DEFAULT_REBALANCE_POLICY.resolveRatio);
    expectTargetsToFit(plan);
  });

  it('trims a target that whole slots would take over the line', () => {
    const cpu: Record<string, number> = { a: 300_000, b: 50_000, c: 50_000 };

    const plan = planOf(
      planRebalance(
        {
          hotShardId: 'a',
          shards: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => shard(id, cpu[id] ?? 100_000)),
          slots: slots(0, even(30, 10_000)),
        },
        { ...DEFAULT_REBALANCE_POLICY, maxTargets: 2 },
      ),
    );

    expect(plan.effect).toBe('headroom');
    expect(plan.moves.map((move) => [move.targetShardId, move.slotCount])).toEqual([
      ['b', 7],
      ['c', 7],
    ]);
    expectTargetsToFit(plan);
  });

  it('never returns a plan that puts a target over the line, whatever the slot load', () => {
    let seed = 20261113;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let plans = 0;
    for (let round = 0; round < 300; round += 1) {
      const others = fleet(2 + Math.floor(random() * 18), 0).map((other) => ({
        ...other,
        cpuUsecPerSecond: Math.floor(20_000 + random() * 200_000),
      }));
      const count = 5 + Math.floor(random() * 400);
      const skew = random();
      const cpus = Array.from({ length: count }, () =>
        Math.floor(random() < skew * 0.1 ? random() * 80_000 : random() * 4_000),
      );
      const load = slots(0, cpus).map((slot, i) => ({
        ...slot,
        slot: i * (random() < 0.05 ? 2 : 1) + (i > count / 2 ? 500 : 0),
        keyCount: Math.floor(random() * 1_000),
      }));
      const input = {
        hotShardId: 'a',
        shards: [
          shard(
            'a',
            load.reduce((sum, slot) => sum + slot.cpuUsecPerSecond, 0),
          ),
          ...others,
        ],
        slots: [...new Map(load.map((slot) => [slot.slot, slot])).values()].sort(
          (x, y) => x.slot - y.slot,
        ),
      };
      const sourceCpu = input.slots.reduce((sum, slot) => sum + slot.cpuUsecPerSecond, 0);

      const verdict = planRebalance(input);

      if (verdict.kind !== 'plan') continue;
      plans += 1;
      expectTargetsToFit(verdict);
      const moved = movedSlots(verdict);
      const pinned = new Set(verdict.pinnedSlots.map((slot) => slot.slot));
      const owned = new Set(input.slots.map((slot) => slot.slot));
      expect(new Set(moved).size).toBe(moved.length);
      expect(moved.every((slot) => owned.has(slot) && !pinned.has(slot))).toBe(true);
      const ranges = verdict.moves.reduce((sum, move) => sum + move.ranges.length, 0);
      expect(ranges).toBeLessThanOrEqual(DEFAULT_REBALANCE_POLICY.maxRanges);
      expect(verdict.moves.length).toBeLessThanOrEqual(DEFAULT_REBALANCE_POLICY.maxTargets);
      const freed = verdict.moves.reduce((sum, move) => sum + move.cpuUsecPerSecond, 0);
      expect(after(verdict, 'a').cpuUsecPerSecond).toBeCloseTo(sourceCpu - freed, 3);
      const resolved = after(verdict, 'a').ratio <= DEFAULT_REBALANCE_POLICY.resolveRatio + 1e-9;
      expect(verdict.effect).toBe(resolved ? 'resolves' : 'headroom');
      if (!resolved) {
        expect(freed).toBeGreaterThanOrEqual(
          DEFAULT_REBALANCE_POLICY.headroomShare * sourceCpu - 1e-6,
        );
      }
    }
    expect(plans).toBeGreaterThan(50);
  });

  it.each([2.5, 3, 4])(
    'offers headroom when four of twenty shards cannot take all of a %sx shard',
    (factor) => {
      const plan = planOf(
        planRebalance({
          hotShardId: 'a',
          shards: [shard('a', factor * 100_000), ...fleet(19, 100_000)],
          slots: slots(0, even(800, (factor * 100_000) / 800)),
        }),
      );

      expect(plan.effect).toBe('headroom');
      expect(plan.moves).toHaveLength(4);
      expectTargetsToFit(plan);
    },
  );

  it.each([5, 8])(
    'does not call the cluster hot when twenty shards have room for a %sx shard but four do not',
    (factor) => {
      const verdict = planRebalance({
        hotShardId: 'a',
        shards: [shard('a', factor * 100_000), ...fleet(19, 100_000)],
        slots: slots(0, even(800, (factor * 100_000) / 800)),
      });

      expect(verdict).toEqual({
        kind: 'no_plan',
        action: 'spread',
        reason: 'too_many_targets',
        pinnedSlots: [],
      });
    },
  );

  it('calls the cluster hot when all the other shards together have no room', () => {
    const verdict = planRebalance({
      hotShardId: 'a',
      shards: [shard('a', 1_600_000), ...fleet(19, 790_000)],
      slots: slots(0, even(800, 2_000)),
    });

    expect(verdict).toMatchObject({ kind: 'no_plan', reason: 'cluster_hot' });
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
    [
      'too_many_targets',
      ' No rebalance is suggested: this load would have to be spread over too many shards.',
    ],
    [
      'slots_scattered',
      " No rebalance is suggested: this shard's slots are too scattered to move enough load in a few ranges.",
    ],
  ])('explains %s', (reason, sentence) => {
    expect(describeNoPlan(noPlan(reason), [])).toBe(sentence);
  });

  it('names the shard whose suggestion covers this one', () => {
    const verdict = {
      ...noPlan('covered_by_other_plan'),
      coveredBy: [{ shardId: 'a', nodeAddr: '10.0.0.1:6379' }],
    } as RebalanceVerdict;

    expect(describeNoPlan(verdict, [])).toBe(
      ' No rebalance is suggested for this shard: the suggestion for 10.0.0.1:6379 already ' +
        'brings its load near the median. Apply that one first.',
    );
  });

  it('names every shard whose suggestion covers this one', () => {
    const verdict = {
      ...noPlan('covered_by_other_plan'),
      coveredBy: [
        { shardId: 'a', nodeAddr: '10.0.0.1:6379' },
        { shardId: 'b', nodeAddr: '10.0.0.2:6379' },
      ],
    } as RebalanceVerdict;

    expect(describeNoPlan(verdict, [])).toBe(
      ' No rebalance is suggested for this shard: the suggestions for 10.0.0.1:6379 and ' +
        '10.0.0.2:6379 already bring its load near the median. Apply those first.',
    );
  });

  it.each(['unhealthy_node', 'migration_running', 'settling'])(
    'says nothing about %s, which may pass while the event stays open',
    (reason) => {
      expect(describeNoPlan(noPlan(reason), [])).toBe('');
    },
  );
});

describe('planRebalances', () => {
  const hotPair = (count: number): RebalanceShard[] => [
    shard('a', 200_000),
    shard('b', 200_000, { hot: true }),
    shard('c', 20_000),
    ...['d', 'e', 'f', 'g'].slice(0, count - 3).map((id) => shard(id, 100_000)),
  ];
  const hot = [
    { hotShardId: 'a', slots: slots(0, even(100, 2_000)) },
    { hotShardId: 'b', slots: slots(200, even(100, 2_000)) },
  ];

  it.each([5, 6, 7])(
    'keeps every target under the line when both plans of %i shards are applied',
    (count) => {
      const shards = hotPair(count);

      const plans = planRebalances(hot, shards).map(planOf);

      const load = new Map(shards.map((each) => [each.shardId, each.cpuUsecPerSecond]));
      for (const plan of plans) {
        for (const move of plan.moves) {
          load.set(move.targetShardId, load.get(move.targetShardId)! + move.cpuUsecPerSecond);
          load.set(plan.sourceShardId, load.get(plan.sourceShardId)! - move.cpuUsecPerSecond);
        }
      }
      const sorted = [...load.values()].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      const targetIds = new Set(
        plans.flatMap((plan) => plan.moves.map((move) => move.targetShardId)),
      );
      expect(targetIds.size).toBeGreaterThan(0);
      for (const targetId of targetIds) {
        expect(load.get(targetId)! / median).toBeLessThanOrEqual(
          DEFAULT_REBALANCE_POLICY.resolveRatio + 1e-9,
        );
      }
    },
  );

  it('shows the later plan the loads the earlier plan leaves', () => {
    const [first, second] = planRebalances(hot, hotPair(5)).map(planOf);
    const moved = first.moves.find((move) => move.targetShardId === 'c')!.cpuUsecPerSecond;

    expect(first.plannedAfter).toEqual([]);
    expect(second.plannedAfter).toEqual(['a']);
    expect(after(first, 'c').cpuUsecPerSecond).toBe(20_000 + moved);
    expect(second.projection.find((row) => row.shardId === 'c')?.before.cpuUsecPerSecond).toBe(
      20_000 + moved,
    );
    expect(second.projection.find((row) => row.shardId === 'a')?.before.cpuUsecPerSecond).toBe(
      after(first, 'a').cpuUsecPerSecond,
    );
  });

  it('plans a shard on top of the plans that are kept', () => {
    const shards = hotPair(5);
    const [first, second] = planRebalances(hot, shards);

    expect(planRebalances([hot[1]], shards, [first])).toEqual([second]);
  });

  it('names only the shards whose plans it counts, not one with no plan', () => {
    const shards = hotPair(5);
    const pinned = { hotShardId: 'a', slots: slots(0, [150_000, 50_000]) };

    const [first, second] = planRebalances([pinned, hot[1]], shards);

    expect(first).toMatchObject({ kind: 'no_plan' });
    expect(planOf(second).plannedAfter).toEqual([]);
  });

  it('counts an empty primary among the owners once an earlier plan fills it', () => {
    const shards = [
      shard('a', 300_000),
      shard('b', 300_000, { hot: true }),
      shard('c', 0, { slotCount: 0 }),
      shard('d', 100_000),
      shard('e', 100_000),
    ];
    const pair = [
      { hotShardId: 'a', slots: slots(0, even(100, 3_000)) },
      { hotShardId: 'b', slots: slots(200, even(100, 3_000)) },
    ];

    const [first, second] = planRebalances(pair, shards).map(planOf);

    expect(first.moves.map((move) => move.targetShardId)).toContain('c');
    const load = new Map(shards.map((each) => [each.shardId, each.cpuUsecPerSecond]));
    for (const plan of [first, second]) {
      for (const move of plan.moves) {
        load.set(move.targetShardId, load.get(move.targetShardId)! + move.cpuUsecPerSecond);
        load.set(plan.sourceShardId, load.get(plan.sourceShardId)! - move.cpuUsecPerSecond);
      }
    }
    const sorted = [...load.values()].sort((x, y) => x - y);
    expect(second.projection.find((row) => row.shardId === 'c')?.before.ratio).toBeGreaterThan(0);
    expect(second.medianAfter).toBeCloseTo(sorted[2]);
    expect(after(second, 'b').ratio).toBeCloseTo(load.get('b')! / sorted[2]);
  });

  describe('a hot shard that an earlier plan brings near the median', () => {
    const covered = (cpu: number): RebalanceShard[] => [
      shard('a', 700_000),
      shard('b', cpu, { hot: true }),
      shard('c', 100_000),
      shard('d', 120_000),
      shard('e', 120_000),
    ];
    const pair = (cpu: number) => [
      { hotShardId: 'a', slots: slots(0, even(100, 7_000)) },
      { hotShardId: 'b', slots: slots(200, even(100, cpu / 100)) },
    ];
    const coveredByA = {
      kind: 'no_plan',
      action: 'spread',
      reason: 'covered_by_other_plan',
      pinnedSlots: [],
      coveredBy: [{ shardId: 'a', nodeAddr: '10.0.0.1:6379' }],
    };

    it.each([250_000, 300_000, 350_000])(
      'says the earlier plan covers it at a load of %i',
      (cpu) => {
        const [first, second] = planRebalances(pair(cpu), covered(cpu));

        expect(planOf(first).effect).toBe('resolves');
        expect(second).toEqual(coveredByA);
      },
    );

    it('says a kept plan covers it', () => {
      const shards = covered(300_000);
      const [first] = planRebalances(pair(300_000), shards);

      expect(planRebalances([pair(300_000)[1]], shards, [first])).toEqual([coveredByA]);
    });

    it('still calls it settling when the measured load is under the line too', () => {
      const [first, second] = planRebalances(pair(140_000), covered(140_000));

      expect(first).toMatchObject({ kind: 'plan' });
      expect(second).toEqual({
        kind: 'no_plan',
        action: 'spread',
        reason: 'settling',
        pinnedSlots: [],
      });
    });
  });

  it('plans one hot shard as planRebalance does', () => {
    const shards = [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000)];
    const input = { hotShardId: 'a', slots: slots(0, even(100, 3_000)) };

    expect(planRebalances([input], shards)).toEqual([planRebalance({ ...input, shards })]);
  });
});

describe('memoryWarnings', () => {
  const GB = 1024 ** 3;
  const plan = () =>
    planOf(
      planRebalance({
        hotShardId: 'a',
        shards: [shard('a', 300_000), shard('b', 100_000), shard('c', 100_000)],
        slots: slots(0, even(100, 3_000), 1_000),
      }),
    );
  const source = { usedBytes: 4 * GB, maxBytes: 8 * GB, keyCount: 100_000 };

  it('moves the plan fixture to one target', () => {
    expect(plan().moves).toMatchObject([{ targetShardId: 'b', keyCount: 26_000 }]);
  });

  it('says nothing when the target keeps room after taking the keys', () => {
    const memory = new Map([
      ['a', source],
      ['b', { usedBytes: 2 * GB, maxBytes: 8 * GB, keyCount: 50_000 }],
    ]);

    expect(memoryWarnings(plan(), memory)).toEqual([]);
  });

  it('warns when the moved keys would take the target past 80% of its memory limit', () => {
    const memory = new Map([
      ['a', source],
      ['b', { usedBytes: 5.5 * GB, maxBytes: 8 * GB, keyCount: 50_000 }],
    ]);

    expect(memoryWarnings(plan(), memory)).toEqual([
      { code: 'target_memory', shardId: 'b', memoryShare: expect.closeTo(0.8175) },
    ]);
  });

  it('uses the limit it is given', () => {
    const memory = new Map([
      ['a', source],
      ['b', { usedBytes: 2 * GB, maxBytes: 8 * GB, keyCount: 50_000 }],
    ]);

    expect(
      memoryWarnings(plan(), memory, [], { ...DEFAULT_REBALANCE_POLICY, targetMemoryShare: 0.3 }),
    ).toEqual([{ code: 'target_memory', shardId: 'b', memoryShare: expect.closeTo(0.38) }]);
  });

  it('counts the keys an earlier plan brings to the same target', () => {
    const memory = new Map([
      ['a', source],
      ['c', source],
      ['b', { usedBytes: 4.5 * GB, maxBytes: 8 * GB, keyCount: 50_000 }],
    ]);
    const earlier = { ...plan(), sourceShardId: 'c' };

    expect(memoryWarnings(plan(), memory)).toEqual([]);
    expect(memoryWarnings(plan(), memory, [earlier])).toEqual([
      { code: 'target_memory', shardId: 'b', memoryShare: expect.closeTo(0.8225) },
    ]);
  });

  it('leaves out an earlier plan that fills another target', () => {
    const memory = new Map([
      ['a', source],
      ['b', { usedBytes: 4.5 * GB, maxBytes: 8 * GB, keyCount: 50_000 }],
    ]);
    const elsewhere = {
      ...plan(),
      sourceShardId: 'c',
      moves: plan().moves.map((move) => ({ ...move, targetShardId: 'd' })),
    };

    expect(memoryWarnings(plan(), memory, [elsewhere])).toEqual([]);
  });

  it('says the memory room is unknown when the source of an earlier plan could not be read', () => {
    const memory = new Map([
      ['a', source],
      ['b', { usedBytes: GB, maxBytes: 8 * GB, keyCount: 50_000 }],
    ]);

    expect(memoryWarnings(plan(), memory, [{ ...plan(), sourceShardId: 'c' }])).toEqual([
      { code: 'memory_unknown', shardId: 'b' },
    ]);
  });

  it.each([
    [
      'the target has no memory limit',
      { a: source, b: { usedBytes: GB, maxBytes: 0, keyCount: 9 } },
    ],
    ['the target could not be read', { a: source }],
    ['the source could not be read', { b: { usedBytes: GB, maxBytes: 8 * GB, keyCount: 9 } }],
    [
      'the source reports no keys',
      { a: { ...source, keyCount: 0 }, b: { usedBytes: GB, maxBytes: 8 * GB, keyCount: 9 } },
    ],
  ])('says the memory room is unknown when %s', (_case, readings) => {
    expect(memoryWarnings(plan(), new Map(Object.entries(readings)))).toEqual([
      { code: 'memory_unknown', shardId: 'b' },
    ]);
  });
});

describe('shardMemoryFromInfo', () => {
  it('reads used memory, the limit and the keys of every database', () => {
    expect(
      shardMemoryFromInfo({
        memory: { used_memory: '1048576', maxmemory: '4194304' },
        keyspace: { db0: 'keys=120,expires=4,avg_ttl=0', db3: 'keys=30,expires=0,avg_ttl=0' },
      }),
    ).toEqual({ usedBytes: 1_048_576, maxBytes: 4_194_304, keyCount: 150 });
  });

  it('reads an empty node with no memory limit', () => {
    expect(shardMemoryFromInfo({ memory: { used_memory: '900000', maxmemory: '0' } })).toEqual({
      usedBytes: 900_000,
      maxBytes: 0,
      keyCount: 0,
    });
  });

  it('gives nothing when the memory section is missing or unreadable', () => {
    expect(shardMemoryFromInfo({})).toBeUndefined();
    expect(shardMemoryFromInfo({ memory: { used_memory: 'n/a', maxmemory: '0' } })).toBeUndefined();
  });
});
