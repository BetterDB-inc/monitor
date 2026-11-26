import { DEFAULT_PLACEMENT_SETTINGS } from '@betterdb/shared';
import type { ShardLoad, ShardLoadSample } from '@app/cluster/shard-load';
import { placementBalance } from '../placement-balance';

function shard(nodeId: string, cpuUsecPerSecond: number, overrides: Partial<ShardLoad> = {}): ShardLoad {
  return {
    nodeId,
    address: `${nodeId}:7000`,
    slotCount: 5461,
    measuredSlots: 5461,
    cpuUsecPerSecond,
    sustainCpuUsecPerSecond: cpuUsecPerSecond,
    baselineCpuUsecPerSecond: cpuUsecPerSecond,
    networkBytesInPerSecond: 0,
    networkBytesOutPerSecond: 0,
    cpuShare: null,
    networkShare: null,
    ...overrides,
  };
}

const sample = (shards: ShardLoad[], settling = false): ShardLoadSample => ({ timestamp: 42, shards, settling });

describe('placementBalance', () => {
  it('returns null without a sample', () => {
    expect(placementBalance(null)).toBeNull();
  });

  it('draws the trigger and resolve lines from the policy', () => {
    const balance = placementBalance(
      sample([shard('a', 200_000), shard('b', 600_000), shard('c', 200_000)]),
      { ...DEFAULT_PLACEMENT_SETTINGS, triggerRatio: 4, resolveRatio: 1.5 },
    );
    expect(balance).toMatchObject({ triggerRatio: 4, resolveRatio: 1.5 });
    expect(balance?.shards.find((s) => s.shardId === 'b')?.overTrigger).toBe(false);
  });

  it('gives each shard its ratio to the median, hottest first, with the trigger and resolve lines', () => {
    const balance = placementBalance(
      sample([shard('a', 200_000), shard('b', 600_000, { cpuShare: 0.6 }), shard('c', 200_000)]),
    );
    expect(balance).toMatchObject({
      sampledAt: 42,
      settling: false,
      medianCpuUsecPerSecond: 200_000,
      triggerRatio: 2,
      resolveRatio: 1.25,
    });
    expect(balance?.shards.map((s) => [s.shardId, s.ratio, s.overTrigger])).toEqual([
      ['b', 3, true],
      ['a', 1, false],
      ['c', 1, false],
    ]);
    expect(balance?.shards[0].cpuShare).toBe(0.6);
  });

  it('leaves shards without slots out of the median and gives them no ratio', () => {
    const balance = placementBalance(
      sample([shard('a', 300_000), shard('b', 300_000), shard('empty', 0, { slotCount: 0 })]),
    );
    expect(balance?.medianCpuUsecPerSecond).toBe(300_000);
    expect(balance?.shards.find((s) => s.shardId === 'empty')).toMatchObject({ ratio: null, overTrigger: false });
  });

  it('does not flag a near-idle cluster', () => {
    const balance = placementBalance(sample([shard('a', 10), shard('b', 40), shard('c', 10)]));
    expect(balance?.shards.every((s) => !s.overTrigger)).toBe(true);
  });

  it('flags nothing below the hot shard minimum of primaries', () => {
    const balance = placementBalance(sample([shard('a', 200_000), shard('b', 900_000)]));
    expect(balance?.shards.every((s) => !s.overTrigger)).toBe(true);
    expect(balance?.shards[0].ratio).toBeCloseTo(900 / 550);
  });

  it('gives each shard its sustain and baseline ratios and the trigger read', () => {
    const balance = placementBalance(
      sample([
        shard('a', 200_000, {
          sustainCpuUsecPerSecond: 100_000,
          baselineCpuUsecPerSecond: 100_000,
        }),
        shard('b', 600_000, {
          sustainCpuUsecPerSecond: 300_000,
          baselineCpuUsecPerSecond: 150_000,
        }),
        shard('c', 200_000, {
          sustainCpuUsecPerSecond: 100_000,
          baselineCpuUsecPerSecond: 100_000,
        }),
        shard('d', 0, { slotCount: 0, sustainCpuUsecPerSecond: 0, baselineCpuUsecPerSecond: 0 }),
      ]),
      DEFAULT_PLACEMENT_SETTINGS,
      (shardId) =>
        shardId === 'b'
          ? { state: 'over', overShare: 1, coveredMs: 1_800_000, firedAt: 40, warmUntil: null }
          : {
              state: 'short_history',
              overShare: 0,
              coveredMs: 60_000,
              firedAt: null,
              warmUntil: 99,
            },
    );
    const row = (id: string) => balance?.shards.find((each) => each.shardId === id);

    expect(row('b')).toMatchObject({
      sustainCpuUsecPerSecond: 300_000,
      sustainRatio: 3,
      baselineRatio: 1.5,
      trigger: 'over',
      warmUntil: null,
    });
    expect(row('a')).toMatchObject({ sustainRatio: 1, trigger: 'short_history', warmUntil: 99 });
    expect(row('d')).toMatchObject({
      sustainRatio: null,
      baselineRatio: null,
      trigger: 'short_history',
      warmUntil: null,
    });
  });

  it('keeps the settling flag and flags nothing while slots settle', () => {
    const balance = placementBalance(sample([shard('a', 200_000), shard('b', 900_000), shard('c', 200_000)], true));
    expect(balance?.settling).toBe(true);
    expect(balance?.shards.every((s) => !s.overTrigger)).toBe(true);
  });
});
