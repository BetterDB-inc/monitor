import type { ShardLoad, ShardLoadSample } from '@app/cluster/shard-load';
import { placementBalance, PLACEMENT_RESOLVE_RATIO, PLACEMENT_TRIGGER_RATIO } from '../placement-balance';

function shard(nodeId: string, cpuUsecPerSecond: number, overrides: Partial<ShardLoad> = {}): ShardLoad {
  return {
    nodeId,
    address: `${nodeId}:7000`,
    slotCount: 5461,
    measuredSlots: 5461,
    cpuUsecPerSecond,
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

  it('gives each shard its ratio to the median, hottest first, with the trigger and resolve lines', () => {
    const balance = placementBalance(
      sample([shard('a', 200_000), shard('b', 600_000, { cpuShare: 0.6 }), shard('c', 200_000)]),
    );
    expect(balance).toMatchObject({
      sampledAt: 42,
      settling: false,
      medianCpuUsecPerSecond: 200_000,
      triggerRatio: PLACEMENT_TRIGGER_RATIO,
      resolveRatio: PLACEMENT_RESOLVE_RATIO,
    });
    expect(balance?.shards.map((s) => [s.shardId, s.ratio, s.overTrigger])).toEqual([
      ['b', 3, true],
      ['a', 1, false],
      ['c', 1, false],
    ]);
    expect(balance?.shards[0].cpuShare).toBe(0.6);
  });

  it('uses 2 and 1.25 as the lines', () => {
    expect(PLACEMENT_TRIGGER_RATIO).toBe(2);
    expect(PLACEMENT_RESOLVE_RATIO).toBe(1.25);
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

  it('keeps the settling flag and flags nothing while slots settle', () => {
    const balance = placementBalance(sample([shard('a', 200_000), shard('b', 900_000), shard('c', 200_000)], true));
    expect(balance?.settling).toBe(true);
    expect(balance?.shards.every((s) => !s.overTrigger)).toBe(true);
  });
});
