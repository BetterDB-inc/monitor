import type { ShardLoad, ShardLoadSample } from '@app/cluster/shard-load';
import {
  HOT_SHARD_RAISE_FACTOR,
  describeHotShard,
  hotShardSignature,
  hotShardSlots,
  judgeHotShards,
} from '../hot-shard-detector';

const MIB = 1024 * 1024;

function shard(nodeId: string, cpu: number, network = 0, slotCount = 5461): ShardLoad {
  return {
    nodeId,
    address: `10.0.0.${nodeId.slice(-1)}:6379`,
    slotCount,
    measuredSlots: slotCount,
    cpuUsecPerSecond: cpu,
    networkBytesInPerSecond: network / 2,
    networkBytesOutPerSecond: network / 2,
    cpuShare: 0,
    networkShare: 0,
  };
}

function sample(shards: ShardLoad[], settling = false): ShardLoadSample {
  const cpuTotal = shards.reduce((sum, s) => sum + s.cpuUsecPerSecond, 0);
  const networkOf = (s: ShardLoad) => s.networkBytesInPerSecond + s.networkBytesOutPerSecond;
  const networkTotal = shards.reduce((sum, s) => sum + networkOf(s), 0);
  return {
    timestamp: 1_000,
    settling,
    shards: shards.map((s) => ({
      ...s,
      cpuShare: cpuTotal > 0 ? s.cpuUsecPerSecond / cpuTotal : 0,
      networkShare: networkTotal > 0 ? networkOf(s) / networkTotal : 0,
    })),
  };
}

const NONE: ReadonlySet<string> = new Set();

describe('judgeHotShards', () => {
  it('flags the shard whose CPU rate is twice the cluster median', () => {
    const findings = judgeHotShards(
      sample([shard('n1', 900_000), shard('n2', 300_000), shard('n3', 280_000)]),
      NONE,
    );

    expect(findings).toHaveLength(1);
    expect(findings![0]).toMatchObject({
      shardId: 'n1',
      nodeAddr: '10.0.0.1:6379',
      slotCount: 5461,
    });
    expect(findings![0].cpu).toMatchObject({ perSecond: 900_000, median: 300_000, ratio: 3 });
    expect(findings![0].cpu.share).toBeCloseTo(900 / 1480);
  });

  it('flags nothing when the load is even', () => {
    expect(
      judgeHotShards(
        sample([shard('n1', 300_000), shard('n2', 310_000), shard('n3', 290_000)]),
        NONE,
      ),
    ).toEqual([]);
  });

  it.each([
    ['under the CPU floor', 50_000],
    ['over the CPU floor', 300_000],
  ])('does not flag a shard on network alone, with every shard %s', (_case, cpu) => {
    expect(
      judgeHotShards(
        sample([shard('n1', cpu, 64 * MIB), shard('n2', cpu, 2 * MIB), shard('n3', cpu, 2 * MIB)]),
        NONE,
      ),
    ).toEqual([]);
  });

  it('does not keep an open shard for its network rate', () => {
    expect(
      judgeHotShards(
        sample([
          shard('n1', 300_000, 64 * MIB),
          shard('n2', 300_000, 2 * MIB),
          shard('n3', 300_000, 2 * MIB),
        ]),
        new Set(['n1']),
      ),
    ).toEqual([]);
  });

  it('gives the network rate of a hot shard as detail, bytes in and out together', () => {
    const findings = judgeHotShards(
      sample([
        shard('n1', 600_000, 16 * MIB),
        shard('n2', 200_000, 2 * MIB),
        shard('n3', 200_000, 2 * MIB),
      ]),
      NONE,
    );

    expect(findings).toHaveLength(1);
    expect(findings![0].network).toEqual({ perSecond: 16 * MIB, share: 0.8, median: 2 * MIB });
    expect(findings![0].cpu.ratio).toBe(3);
  });

  it('ignores a ratio over the factor while the rate is under the floor', () => {
    expect(
      judgeHotShards(
        sample([shard('n1', 90_000, MIB / 2), shard('n2', 10_000, 1_000), shard('n3', 10_000, 0)]),
        NONE,
      ),
    ).toEqual([]);
  });

  it('gives a finite ratio when every other shard is idle', () => {
    const findings = judgeHotShards(
      sample([shard('n1', 900_000), shard('n2', 0), shard('n3', 0)]),
      NONE,
    );

    expect(findings).toHaveLength(1);
    expect(findings![0].cpu).toMatchObject({ median: 0, ratio: 18 });
    expect(findings![0].network).toEqual({ perSecond: 0, share: 0, median: 0 });
    expect(JSON.stringify(findings)).not.toMatch(/null|NaN|Infinity/);
  });

  it('reports ratio zero, not NaN, for a cluster with no load at all', () => {
    const findings = judgeHotShards(sample([shard('n1', 0), shard('n2', 0), shard('n3', 0)]), NONE);

    expect(findings).toEqual([]);
  });

  it('sits exactly at the raise factor when a shard reaches the floor in an idle cluster', () => {
    const findings = judgeHotShards(
      sample([shard('n1', 100_000), shard('n2', 0), shard('n3', 0)]),
      NONE,
    );

    expect(findings![0].cpu.ratio).toBe(HOT_SHARD_RAISE_FACTOR);
  });

  it('needs three slot-owning primaries', () => {
    expect(judgeHotShards(sample([shard('n1', 900_000), shard('n2', 100_000)]), NONE)).toEqual([]);
  });

  it('does not count a primary without slots, for the rule or for the median', () => {
    expect(
      judgeHotShards(
        sample([shard('n1', 900_000), shard('n2', 100_000), shard('n3', 0, 0, 0)]),
        NONE,
      ),
    ).toEqual([]);

    const findings = judgeHotShards(
      sample([
        shard('n1', 500_000),
        shard('n2', 300_000),
        shard('n3', 200_000),
        shard('n4', 0, 0, 0),
        shard('n5', 0, 0, 0),
      ]),
      NONE,
    );

    expect(findings).toEqual([]);
  });

  it('cannot judge a sample that is still settling', () => {
    expect(
      judgeHotShards(
        sample([shard('n1', 900_000), shard('n2', 100_000), shard('n3', 100_000)], true),
        NONE,
      ),
    ).toBeNull();
  });

  it('keeps an open shard until it drops under the release factor', () => {
    const at = (cpu: number) =>
      sample([shard('n1', cpu), shard('n2', 300_000), shard('n3', 300_000)]);
    const open = new Set(['n1']);

    expect(judgeHotShards(at(480_000), NONE)).toEqual([]);
    expect(judgeHotShards(at(480_000), open)).toHaveLength(1);
    expect(judgeHotShards(at(440_000), open)).toEqual([]);
  });

  it('keeps an open shard a little under the floor, so it does not flap around it', () => {
    const at = (cpu: number) => sample([shard('n1', cpu), shard('n2', 0), shard('n3', 0)]);
    const open = new Set(['n1']);

    expect(judgeHotShards(at(80_000), NONE)).toEqual([]);
    expect(judgeHotShards(at(80_000), open)).toHaveLength(1);
    expect(judgeHotShards(at(70_000), open)).toEqual([]);
  });

  it('flags no shard when two of three carry the load', () => {
    expect(
      judgeHotShards(
        sample([shard('n1', 900_000), shard('n2', 900_000), shard('n3', 100_000)]),
        NONE,
      ),
    ).toEqual([]);
  });
});

describe('hotShardSignature', () => {
  it('is one key per shard', () => {
    expect(hotShardSignature('abc')).toBe('hot_shard:abc');
  });
});

describe('hotShardSlots', () => {
  const slots = [
    {
      slot: 12,
      cpuUsecPerSecond: 450_000,
      networkBytesInPerSecond: 100,
      networkBytesOutPerSecond: 300,
      keyCount: 7,
    },
    {
      slot: 99,
      cpuUsecPerSecond: 90_000,
      networkBytesInPerSecond: 0,
      networkBytesOutPerSecond: 0,
      keyCount: 2,
    },
  ];

  it("gives each slot its part of the shard's CPU", () => {
    const [finding] = judgeHotShards(
      sample([shard('n1', 900_000), shard('n2', 300_000), shard('n3', 300_000)]),
      NONE,
    )!;

    expect(hotShardSlots(finding, slots)).toEqual([
      {
        slot: 12,
        cpuUsecPerSecond: 450_000,
        networkBytesPerSecond: 400,
        keyCount: 7,
        shareOfShard: 0.5,
      },
      {
        slot: 99,
        cpuUsecPerSecond: 90_000,
        networkBytesPerSecond: 0,
        keyCount: 2,
        shareOfShard: 0.1,
      },
    ]);
  });

  it('uses the CPU rate when the network rate of the shard is further over', () => {
    const [finding] = judgeHotShards(
      sample([
        shard('n1', 900_000, 64 * MIB),
        shard('n2', 300_000, MIB),
        shard('n3', 300_000, MIB),
      ]),
      NONE,
    )!;

    expect(hotShardSlots(finding, slots)[0].shareOfShard).toBe(0.5);
  });
});

describe('describeHotShard', () => {
  const topSlots = [
    { slot: 1234, cpuUsecPerSecond: 0, networkBytesPerSecond: 0, keyCount: 0, shareOfShard: 0.62 },
    { slot: 88, cpuUsecPerSecond: 0, networkBytesPerSecond: 0, keyCount: 0, shareOfShard: 0.09 },
    { slot: 4001, cpuUsecPerSecond: 0, networkBytesPerSecond: 0, keyCount: 0, shareOfShard: 0.04 },
    { slot: 7, cpuUsecPerSecond: 0, networkBytesPerSecond: 0, keyCount: 0, shareOfShard: 0.01 },
  ];

  it('names the shard, how far over it is, for how long, and its top slots', () => {
    const [finding] = judgeHotShards(
      sample([shard('3f2a9c1e77aa', 930_000), shard('n2', 300_000), shard('n3', 300_000)]),
      NONE,
    )!;

    expect(describeHotShard(finding, topSlots, 60_000)).toBe(
      "Hot shard 3f2a9c1e at 10.0.0.a:6379: CPU 3.1x the cluster median (61% of the cluster's slot CPU) for 60s. " +
        'Top slots by CPU: 1234 (62% of the shard), 88 (9%), 4001 (4%).',
    );
  });

  it('names the hot keys after the top slots', () => {
    const [finding] = judgeHotShards(
      sample([shard('3f2a9c1e77aa', 930_000), shard('n2', 300_000), shard('n3', 300_000)]),
      NONE,
    )!;
    const keys = [
      { key: 'user:42', slot: 1234, freq: 255 },
      { key: 'cart:{9}', slot: 88, freq: 201 },
    ];

    expect(describeHotShard(finding, topSlots.slice(0, 1), 60_000, keys)).toBe(
      "Hot shard 3f2a9c1e at 10.0.0.a:6379: CPU 3.1x the cluster median (61% of the cluster's slot CPU) for 60s. " +
        'Top slots by CPU: 1234 (62% of the shard). ' +
        'Hot keys: "user:42" (freq 255), "cart:{9}" (freq 201).',
    );
  });

  it('ends with the note about missing key names when it is given one', () => {
    const [finding] = judgeHotShards(
      sample([shard('3f2a9c1e77aa', 930_000), shard('n2', 300_000), shard('n3', 300_000)]),
      NONE,
    )!;

    expect(
      describeHotShard(
        finding,
        topSlots.slice(0, 1),
        60_000,
        [],
        ' Key names are not available (no LFU policy); a capture on this primary can show them.',
      ),
    ).toBe(
      "Hot shard 3f2a9c1e at 10.0.0.a:6379: CPU 3.1x the cluster median (61% of the cluster's slot CPU) for 60s. " +
        'Top slots by CPU: 1234 (62% of the shard). ' +
        'Key names are not available (no LFU policy); a capture on this primary can show them.',
    );
  });

  it('gives the network share as detail that includes replication, not as a reason', () => {
    const [finding] = judgeHotShards(
      sample([
        shard('n1', 600_000, 16 * MIB),
        shard('n2', 200_000, 2 * MIB),
        shard('n3', 200_000, 2 * MIB),
      ]),
      NONE,
    )!;

    expect(describeHotShard(finding, [], 75_400)).toBe(
      "Hot shard n1 at 10.0.0.1:6379: CPU 3.0x the cluster median (60% of the cluster's slot CPU) for 75s. " +
        "Network: 80% of the cluster's bytes, replication included.",
    );
    expect(describeHotShard(finding, topSlots.slice(0, 1), 75_400)).toMatch(
      /replication included\. Top slots by CPU: 1234 \(62% of the shard\)\.$/,
    );
  });

  it('gives the rate itself when the rest of the cluster is near idle', () => {
    const [finding] = judgeHotShards(
      sample([shard('n1', 900_000), shard('n2', 0), shard('n3', 0)]),
      NONE,
    )!;

    expect(describeHotShard(finding, topSlots.slice(0, 1), 60_000)).toBe(
      "Hot shard n1 at 10.0.0.1:6379: CPU 0.90 cores against a near-idle cluster median (100% of the cluster's slot CPU) for 60s. " +
        'Top slots by CPU: 1234 (62% of the shard).',
    );
  });
});
