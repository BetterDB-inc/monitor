import {
  RESHARD_MARKER_STALL_MS,
  ReshardShardSnapshot,
  evaluateReshardSkew,
  isMarkerStalled,
  isReshardActive,
  reshardMarkerSignature,
  reshardRole,
} from '../reshard-pressure-detector';

const GB = 1024 * 1024 * 1024;
const NOW = 1_700_000_000_000;
const QUIET_MS = 2000;

function shard(id: string, over: Partial<ReshardShardSnapshot> = {}): ReshardShardSnapshot {
  return {
    connectionId: `conn-${id}`,
    clusterKey: 'cluster:a',
    shardId: `${id}0000000`,
    migratingSlots: 0,
    importingSlots: 0,
    markerSignature: '|',
    markerChangedAt: NOW,
    lastMarkerAt: null,
    opsPerSec: 10_000,
    cpuUtilization: 40,
    usedMemory: 2 * GB,
    writeP99Us: 500,
    timestamp: NOW,
    ...over,
  };
}

function cluster(self: ReshardShardSnapshot, ...others: ReshardShardSnapshot[]) {
  return [self, ...(others.length > 0 ? others : [shard('b'), shard('c')])];
}

describe('isReshardActive', () => {
  it('is active while a shard carries slot markers', () => {
    expect(isReshardActive([shard('a', { lastMarkerAt: NOW })], NOW, QUIET_MS)).toBe(true);
  });

  it('stays active through a short quiet period', () => {
    expect(isReshardActive([shard('a', { lastMarkerAt: NOW - QUIET_MS })], NOW, QUIET_MS)).toBe(
      true,
    );
  });

  it('closes once the quiet period has passed', () => {
    expect(isReshardActive([shard('a', { lastMarkerAt: NOW - QUIET_MS - 1 })], NOW, QUIET_MS)).toBe(
      false,
    );
  });

  it('is inactive when no shard ever carried a marker', () => {
    expect(isReshardActive([shard('a'), shard('b')], NOW, QUIET_MS)).toBe(false);
  });
});

describe('reshard marker progress', () => {
  it('signs the marker set regardless of order', () => {
    expect(reshardMarkerSignature([{ slot: 9 }, { slot: 3 }], [{ slot: 5 }])).toBe(
      reshardMarkerSignature([{ slot: 3 }, { slot: 9 }], [{ slot: 5 }]),
    );
  });

  it('tells a migrating slot from an importing one', () => {
    expect(reshardMarkerSignature([{ slot: 3 }], [])).not.toBe(
      reshardMarkerSignature([], [{ slot: 3 }]),
    );
  });

  it('calls a marker stalled after thirty unchanged minutes', () => {
    expect(isMarkerStalled(NOW - RESHARD_MARKER_STALL_MS + 1, NOW)).toBe(false);
    expect(isMarkerStalled(NOW - RESHARD_MARKER_STALL_MS, NOW)).toBe(true);
  });
});

describe('reshardRole', () => {
  it('names the side of the migration', () => {
    expect(reshardRole(shard('a', { migratingSlots: 3 }))).toBe('source');
    expect(reshardRole(shard('a', { importingSlots: 3 }))).toBe('target');
    expect(reshardRole(shard('a', { migratingSlots: 1, importingSlots: 1 }))).toBe(
      'source and target',
    );
    expect(reshardRole(shard('a'))).toBe('bystander');
  });
});

describe('evaluateReshardSkew', () => {
  it('flags a loaded shard while the cluster aggregate stays flat', () => {
    const self = shard('a', { opsPerSec: 18_000, migratingSlots: 5 });
    const others = [shard('b', { opsPerSec: 6000 }), shard('c', { opsPerSec: 6000 })];

    const finding = evaluateReshardSkew(self, cluster(self, ...others));

    expect(finding).toMatchObject({
      clusterKey: 'cluster:a',
      shardId: self.shardId,
      role: 'source',
    });
    expect(finding?.deviations).toEqual([
      { metric: 'ops/sec', value: 18_000, median: 6000, ratio: 3, threshold: 2 },
    ]);
  });

  it('reports every metric that deviates', () => {
    const self = shard('a', {
      opsPerSec: 30_000,
      cpuUtilization: 90,
      usedMemory: 4 * GB,
      writeP99Us: 3000,
    });

    const finding = evaluateReshardSkew(self, cluster(self));

    expect(finding?.deviations.map((d) => d.metric)).toEqual([
      'ops/sec',
      'CPU',
      'memory',
      'write P99',
    ]);
  });

  it('does not flag an evenly loaded cluster', () => {
    const self = shard('a');
    expect(evaluateReshardSkew(self, cluster(self))).toBeNull();
  });

  it('does not flag a shard under light cluster load', () => {
    const self = shard('a', { opsPerSec: 500 });
    const others = [shard('b', { opsPerSec: 100 }), shard('c', { opsPerSec: 100 })];
    expect(evaluateReshardSkew(self, cluster(self, ...others))).toBeNull();
  });

  it('needs three primaries to judge a median', () => {
    const self = shard('a', { opsPerSec: 30_000 });
    expect(evaluateReshardSkew(self, [self, shard('b')])).toBeNull();
  });

  it('holds a metric to its absolute floor', () => {
    const self = shard('a', { cpuUtilization: 45 });
    const others = [shard('b', { cpuUtilization: 20 }), shard('c', { cpuUtilization: 20 })];
    expect(evaluateReshardSkew(self, cluster(self, ...others))).toBeNull();
  });

  it('skips a metric too few primaries reported', () => {
    const self = shard('a', { cpuUtilization: 95 });
    const others = [shard('b', { cpuUtilization: null }), shard('c', { cpuUtilization: null })];
    expect(evaluateReshardSkew(self, cluster(self, ...others))).toBeNull();
  });

  it('skips a metric this shard did not report', () => {
    const self = shard('a', { writeP99Us: null });
    const others = [shard('b', { writeP99Us: 400 }), shard('c', { writeP99Us: 400 })];
    expect(evaluateReshardSkew(self, cluster(self, ...others))).toBeNull();
  });

  it('keeps the ratio finite when the median is zero', () => {
    const self = shard('a', { writeP99Us: 2000 });
    const others = [shard('b', { writeP99Us: 0 }), shard('c', { writeP99Us: 0 })];

    const finding = evaluateReshardSkew(self, cluster(self, ...others));

    expect(finding?.deviations).toEqual([
      { metric: 'write P99', value: 2000, median: 0, ratio: 3, threshold: 3 },
    ]);
  });
});
