import { SlotStats } from '../common/types/metrics.types';
import { NodeSlotStats, SHARD_LOAD_SMOOTHING_MS, ShardLoadTracker } from './shard-load';

type Counters = [cpuUsec: number, bytesIn: number, bytesOut: number];

function node(nodeId: string, slots: Record<number, Counters>): NodeSlotStats {
  const stats: SlotStats = {};
  for (const [slot, [cpu, bytesIn, bytesOut]] of Object.entries(slots)) {
    stats[slot] = {
      key_count: 10,
      cpu_usec: cpu,
      network_bytes_in: bytesIn,
      network_bytes_out: bytesOut,
    };
  }
  return { nodeId, address: `10.0.0.${nodeId.slice(-1)}:6379`, stats };
}

function shardOf(sample: ReturnType<ShardLoadTracker['observe']>, nodeId: string) {
  const shard = sample?.shards.find((s) => s.nodeId === nodeId);
  if (!shard) throw new Error(`no shard ${nodeId} in the sample`);
  return shard;
}

describe('ShardLoadTracker', () => {
  it('has no rate to report from a single reading', () => {
    const tracker = new ShardLoadTracker();

    expect(tracker.observe([node('n1', { 0: [1000, 100, 100] })], 0)).toBeNull();
  });

  it('turns two cumulative readings into per-second rates per shard', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe(
      [node('n1', { 0: [1_000, 100, 200], 1: [5_000, 0, 0] }), node('n2', { 2: [0, 0, 0] })],
      0,
    );

    const sample = tracker.observe(
      [
        node('n1', { 0: [11_000, 600, 1_200], 1: [15_000, 0, 0] }),
        node('n2', { 2: [5_000, 250, 250] }),
      ],
      5_000,
    );

    expect(sample?.timestamp).toBe(5_000);
    expect(shardOf(sample, 'n1')).toMatchObject({
      address: '10.0.0.1:6379',
      slotCount: 2,
      cpuUsecPerSecond: 4_000,
      networkBytesInPerSecond: 100,
      networkBytesOutPerSecond: 200,
    });
    expect(shardOf(sample, 'n2')).toMatchObject({
      slotCount: 1,
      cpuUsecPerSecond: 1_000,
      networkBytesInPerSecond: 50,
      networkBytesOutPerSecond: 50,
    });
  });

  it('reports each shard as a share of the cluster total', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [0, 0, 0] }), node('n2', { 1: [0, 0, 0] })], 0);

    const sample = tracker.observe(
      [node('n1', { 0: [3_000, 900, 0] }), node('n2', { 1: [1_000, 0, 100] })],
      1_000,
    );

    expect(shardOf(sample, 'n1').cpuShare).toBeCloseTo(0.75);
    expect(shardOf(sample, 'n2').cpuShare).toBeCloseTo(0.25);
    expect(shardOf(sample, 'n1').networkShare).toBeCloseTo(0.9);
    expect(shardOf(sample, 'n2').networkShare).toBeCloseTo(0.1);
  });

  it('reports a zero share when the cluster is idle', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [5, 5, 5] }), node('n2', { 1: [5, 5, 5] })], 0);

    const sample = tracker.observe(
      [node('n1', { 0: [5, 5, 5] }), node('n2', { 1: [5, 5, 5] })],
      1_000,
    );

    expect(shardOf(sample, 'n1')).toMatchObject({
      cpuUsecPerSecond: 0,
      cpuShare: 0,
      networkShare: 0,
    });
  });

  it('smooths the rate so one busy interval does not move it all the way', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [0, 0, 0] })], 0);
    tracker.observe([node('n1', { 0: [500, 0, 0] })], 5_000);

    const sample = tracker.observe([node('n1', { 0: [1_500, 0, 0] })], 10_000);

    const weight = 1 - Math.exp(-5_000 / SHARD_LOAD_SMOOTHING_MS);
    expect(shardOf(sample, 'n1').cpuUsecPerSecond).toBeCloseTo(100 + weight * (200 - 100));
  });

  it('leaves out a slot whose counter went backwards, then picks it up again', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [9_000, 0, 0], 1: [0, 0, 0] })], 0);

    const afterReset = tracker.observe([node('n1', { 0: [50, 0, 0], 1: [1_000, 0, 0] })], 1_000);

    expect(shardOf(afterReset, 'n1').cpuUsecPerSecond).toBe(1_000);
    expect(shardOf(afterReset, 'n1').measuredSlots).toBe(1);
    expect(afterReset?.settling).toBe(true);

    const resumed = tracker.observe([node('n1', { 0: [250, 0, 0], 1: [1_000, 0, 0] })], 2_000);

    expect(shardOf(resumed, 'n1').measuredSlots).toBe(2);
    expect(resumed?.settling).toBe(false);
    expect(tracker.topSlots('n1', 5)).toContainEqual(
      expect.objectContaining({ slot: 0, cpuUsecPerSecond: 200 }),
    );
  });

  it('starts over once a node stops tracking usage', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [0, 0, 0] })], 0);
    tracker.observe(
      [{ nodeId: 'n1', address: '10.0.0.1:6379', stats: { 0: { key_count: 4 } } }],
      1_000,
    );

    expect(tracker.observe([node('n1', { 0: [900, 0, 0] })], 2_000)).toBeNull();
    expect(tracker.topSlots('n1', 5)).toEqual([]);
  });

  it('does not credit a moved slot to its new owner for the interval it moved in', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [0, 0, 0], 1: [0, 0, 0] }), node('n2', { 2: [0, 0, 0] })], 0);
    tracker.observe(
      [node('n1', { 0: [100, 0, 0], 1: [100, 0, 0] }), node('n2', { 2: [100, 0, 0] })],
      1_000,
    );

    const moved = tracker.observe(
      [node('n1', { 0: [200, 0, 0] }), node('n2', { 1: [70_000, 0, 0], 2: [200, 0, 0] })],
      2_000,
    );

    expect(shardOf(moved, 'n2')).toMatchObject({ slotCount: 2, measuredSlots: 1 });
    expect(shardOf(moved, 'n2').cpuUsecPerSecond).toBeCloseTo(100);
  });

  it('marks the samples around a slot move as settling', () => {
    const tracker = new ShardLoadTracker();
    const before = [node('n1', { 0: [0, 0, 0], 1: [0, 0, 0] }), node('n2', { 2: [0, 0, 0] })];
    const after = [node('n1', { 0: [0, 0, 0] }), node('n2', { 1: [0, 0, 0], 2: [0, 0, 0] })];
    tracker.observe(before, 0);

    expect(tracker.observe(before, 1_000)?.settling).toBe(false);
    expect(tracker.observe(after, 2_000)?.settling).toBe(true);
    expect(tracker.observe(after, 3_000)?.settling).toBe(true);
    expect(tracker.observe(after, 4_000)?.settling).toBe(true);
    expect(tracker.observe(after, 5_000)?.settling).toBe(false);
  });

  it('treats a slot that lost its owner as a move', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [0, 0, 0], 1: [0, 0, 0] })], 0);

    const sample = tracker.observe([node('n1', { 0: [100, 0, 0] })], 1_000);

    expect(sample?.settling).toBe(true);
    expect(tracker.topSlots('n1', 5).map((s) => s.slot)).toEqual([0]);
  });

  it('keeps a shard that has no measured slot yet, and gives no shard the whole load', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [0, 0, 0] })], 0);

    const sample = tracker.observe(
      [node('n1', { 0: [100, 50, 50] }), node('n3', { 1: [900, 0, 0] })],
      1_000,
    );

    expect(sample?.settling).toBe(true);
    expect(sample?.shards.map((s) => s.nodeId)).toEqual(['n1', 'n3']);
    expect(shardOf(sample, 'n3')).toMatchObject({
      slotCount: 1,
      measuredSlots: 0,
      cpuUsecPerSecond: 0,
      cpuShare: null,
      networkShare: null,
    });
    expect(shardOf(sample, 'n1').cpuUsecPerSecond).toBe(100);
    expect(shardOf(sample, 'n1').cpuShare).not.toBe(1);
    expect(shardOf(sample, 'n1').cpuShare).toBeNull();
    expect(shardOf(sample, 'n1').networkShare).toBeNull();
  });

  it('holds every share while a restarted primary has no measured slot', () => {
    const tracker = new ShardLoadTracker();
    const reading = (n1: number, n2: number, n3: number) => [
      node('n1', { 0: [n1, n1, 0] }),
      node('n2', { 1: [n2, n2, 0] }),
      node('n3', { 2: [n3, n3, 0] }),
    ];
    tracker.observe(reading(0, 0, 0), 0);
    const before = tracker.observe(reading(600, 300, 100), 1_000);

    const restarted = tracker.observe(reading(1_500, 600, 5), 2_000);

    expect(before?.settling).toBe(false);
    expect(restarted?.settling).toBe(true);
    expect(shardOf(restarted, 'n3')).toMatchObject({ measuredSlots: 0, cpuUsecPerSecond: 0 });
    for (const sample of [before, restarted]) {
      expect(shardOf(sample, 'n1').cpuShare).toBeCloseTo(0.6);
      expect(shardOf(sample, 'n2').cpuShare).toBeCloseTo(0.3);
      expect(shardOf(sample, 'n3').cpuShare).toBeCloseTo(0.1);
      expect(shardOf(sample, 'n1').networkShare).toBeCloseTo(0.6);
      expect(shardOf(sample, 'n3').networkShare).toBeCloseTo(0.1);
    }

    const resumed = tracker.observe(reading(1_500, 600, 1_005), 3_000);

    expect(resumed?.settling).toBe(false);
    expect(shardOf(resumed, 'n3').cpuUsecPerSecond).toBe(1_000);
    const shares = resumed?.shards.map((s) => s.cpuShare ?? 0) ?? [];
    expect(shares.reduce((total, share) => total + share, 0)).toBeCloseTo(1);
    expect(shardOf(resumed, 'n3').cpuShare).toBeGreaterThan(0.1);
  });

  it('holds the shares until a slot move has settled, with none for a new shard', () => {
    const tracker = new ShardLoadTracker();
    const before = (step: number) => [
      node('n1', { 0: [300 * step, 0, 0], 1: [300 * step, 0, 0] }),
      node('n2', { 2: [400 * step, 0, 0] }),
    ];
    const after = (step: number) => [
      node('n1', { 0: [300 * step, 0, 0] }),
      node('n2', { 2: [400 * step, 0, 0] }),
      node('n3', { 1: [300 * step, 0, 0] }),
    ];
    tracker.observe(before(0), 0);
    tracker.observe(before(1), 1_000);

    for (const step of [2, 3, 4]) {
      const settling = tracker.observe(after(step), step * 1_000);

      expect(settling?.settling).toBe(true);
      expect(shardOf(settling, 'n1').cpuShare).toBeCloseTo(0.6);
      expect(shardOf(settling, 'n2').cpuShare).toBeCloseTo(0.4);
      expect(shardOf(settling, 'n3').cpuShare).toBeNull();
      expect(shardOf(settling, 'n1').cpuUsecPerSecond).toBeCloseTo(300);
    }

    const settled = tracker.observe(after(5), 5_000);

    expect(settled?.settling).toBe(false);
    expect(shardOf(settled, 'n1').cpuShare).toBeCloseTo(0.3);
    expect(shardOf(settled, 'n2').cpuShare).toBeCloseTo(0.4);
    expect(shardOf(settled, 'n3').cpuShare).toBeCloseTo(0.3);
  });

  it('forgets the held shares when it starts over', () => {
    const tracker = new ShardLoadTracker();
    const untracked: NodeSlotStats = {
      nodeId: 'n1',
      address: '10.0.0.1:6379',
      stats: { 0: { key_count: 4 } },
    };
    tracker.observe([node('n1', { 0: [0, 0, 0] })], 0);
    tracker.observe([node('n1', { 0: [100, 0, 0] })], 1_000);
    tracker.observe([untracked], 2_000);
    tracker.observe([node('n1', { 0: [0, 0, 0] })], 3_000);

    const sample = tracker.observe(
      [node('n1', { 0: [100, 0, 0] }), node('n2', { 1: [0, 0, 0] })],
      4_000,
    );

    expect(sample?.settling).toBe(true);
    expect(shardOf(sample, 'n1').cpuShare).toBeNull();
  });

  it('measures across a skipped pass with the longer interval', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [0, 0, 0] })], 0);

    const sample = tracker.observe([node('n1', { 0: [3_000, 0, 0] })], 15_000);

    expect(shardOf(sample, 'n1').cpuUsecPerSecond).toBe(200);
  });

  it('reports nothing while a node does not track usage', () => {
    const tracker = new ShardLoadTracker();
    const untracked: NodeSlotStats = {
      nodeId: 'n2',
      address: '10.0.0.2:6379',
      stats: { 1: { key_count: 4 } },
    };
    tracker.observe([node('n1', { 0: [0, 0, 0] }), untracked], 0);

    expect(tracker.observe([node('n1', { 0: [100, 0, 0] }), untracked], 1_000)).toBeNull();
  });

  it('ignores a reading that is not newer than the last one', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe([node('n1', { 0: [0, 0, 0] })], 1_000);

    expect(tracker.observe([node('n1', { 0: [100, 0, 0] })], 1_000)).toBeNull();
    expect(
      shardOf(tracker.observe([node('n1', { 0: [100, 0, 0] })], 2_000), 'n1').cpuUsecPerSecond,
    ).toBe(100);
  });

  it('ranks the slots of one shard by CPU rate, then by network rate', () => {
    const tracker = new ShardLoadTracker();
    tracker.observe(
      [node('n1', { 0: [0, 0, 0], 1: [0, 0, 0], 2: [0, 0, 0] }), node('n2', { 3: [0, 0, 0] })],
      0,
    );
    tracker.observe(
      [
        node('n1', { 0: [100, 0, 0], 1: [900, 10, 10], 2: [100, 500, 500] }),
        node('n2', { 3: [5_000, 0, 0] }),
      ],
      1_000,
    );

    expect(tracker.topSlots('n1', 2)).toEqual([
      {
        slot: 1,
        cpuUsecPerSecond: 900,
        networkBytesInPerSecond: 10,
        networkBytesOutPerSecond: 10,
        keyCount: 10,
      },
      {
        slot: 2,
        cpuUsecPerSecond: 100,
        networkBytesInPerSecond: 500,
        networkBytesOutPerSecond: 500,
        keyCount: 10,
      },
    ]);
  });

  it('separates a shard under skewed write load from an evenly loaded cluster', () => {
    const readings = (perShardCpu: number[], step: number) =>
      perShardCpu.map((cpu, i) => node(`n${i + 1}`, { [i]: [cpu * step, cpu * step, 0] }));
    const skewed = new ShardLoadTracker();
    const uniform = new ShardLoadTracker();
    let skewedSample = null;
    let uniformSample = null;
    for (let step = 0; step <= 12; step++) {
      skewedSample = skewed.observe(readings([900_000, 100_000, 100_000], step), step * 5_000);
      uniformSample = uniform.observe(readings([300_000, 310_000, 290_000], step), step * 5_000);
    }

    expect(shardOf(skewedSample, 'n1').cpuShare).toBeCloseTo(0.818, 2);
    expect(shardOf(uniformSample, 'n1').cpuShare).toBeCloseTo(0.333, 2);
  });
});
