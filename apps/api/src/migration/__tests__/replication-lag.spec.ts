import {
  applyLagUpdate,
  buildLagSnapshot,
  countSourceShards,
  type ReplicationLagMap,
} from '../execution/replication-lag';

const NOW = 1_000_000;
const lag = (shard: string, diff: number) => ({ shardLag: { shard, diff }, shardState: { shard, inAof: true } });
const rdb = (shard: string) => ({ shardLag: null, shardState: { shard, inAof: false } });

function mapOf(entries: Array<[string, number | null, number]>): ReplicationLagMap {
  return new Map(entries.map(([shard, diff, updatedAt]) => [shard, { diff, updatedAt }]));
}

describe('applyLagUpdate', () => {
  it('records diff and timestamp for a shard in aof', () => {
    const map: ReplicationLagMap = new Map();
    applyLagUpdate(map, lag('src-0', 0), NOW);
    expect(map.get('src-0')).toEqual({ diff: 0, updatedAt: NOW });
  });

  it('resets a shard to null diff when it reports a non-aof state', () => {
    const map: ReplicationLagMap = new Map();
    applyLagUpdate(map, lag('src-1', 0), NOW);
    applyLagUpdate(map, rdb('src-1'), NOW + 1);
    expect(map.get('src-1')).toEqual({ diff: null, updatedAt: NOW + 1 });
  });

  it('ignores a parse with no shard fields', () => {
    const map: ReplicationLagMap = new Map();
    applyLagUpdate(map, { shardLag: null, shardState: null }, NOW);
    expect(map.size).toBe(0);
  });
});

describe('buildLagSnapshot', () => {
  it('returns null lag and false for a null map', () => {
    expect(buildLagSnapshot(null, null, null, NOW)).toEqual({ replicationLag: null, fullySynced: false });
  });

  it('sorts entries by numeric shard index', () => {
    const map = mapOf([['src-10', 0, NOW], ['src-2', 0, NOW], ['src-0', 0, NOW]]);
    const { replicationLag } = buildLagSnapshot(map, 3, 'aof_replicating', NOW);
    expect(replicationLag?.map((e) => e.shard)).toEqual(['src-0', 'src-2', 'src-10']);
  });

  it('is fully synced when every expected shard is fresh and zero in aof_replicating', () => {
    const map = mapOf([['src-0', 0, NOW], ['src-1', 0, NOW], ['src-2', 0, NOW]]);
    expect(buildLagSnapshot(map, 3, 'aof_replicating', NOW).fullySynced).toBe(true);
  });

  it('is not fully synced before every expected shard has reported', () => {
    expect(buildLagSnapshot(mapOf([['src-0', 0, NOW]]), 6, 'aof_replicating', NOW).fullySynced).toBe(false);
  });

  it('is not fully synced when expectedShards is null', () => {
    expect(buildLagSnapshot(mapOf([['src-0', 0, NOW]]), null, 'aof_replicating', NOW).fullySynced).toBe(false);
  });

  it('is not fully synced when any shard lags', () => {
    const map = mapOf([['src-0', 0, NOW], ['src-1', 1, NOW]]);
    expect(buildLagSnapshot(map, 2, 'aof_replicating', NOW).fullySynced).toBe(false);
  });

  it('is not fully synced when any shard is in initial sync', () => {
    const map = mapOf([['src-0', 0, NOW], ['src-1', null, NOW]]);
    expect(buildLagSnapshot(map, 2, 'aof_replicating', NOW).fullySynced).toBe(false);
  });

  it('is not fully synced outside aof_replicating', () => {
    expect(buildLagSnapshot(mapOf([['src-0', 0, NOW]]), 1, 'rdb_syncing', NOW).fullySynced).toBe(false);
  });

  it('treats a report older than max(10s, 3 × shards × 1s) as stale', () => {
    const two = (age: number) => mapOf([['src-0', 0, NOW], ['src-1', 0, NOW - age]]);
    expect(buildLagSnapshot(two(10_001), 2, 'aof_replicating', NOW).fullySynced).toBe(false);
    expect(buildLagSnapshot(two(9_999), 2, 'aof_replicating', NOW).fullySynced).toBe(true);
    const five = mapOf([['src-0', 0, NOW], ['src-1', 0, NOW], ['src-2', 0, NOW], ['src-3', 0, NOW], ['src-4', 0, NOW - 14_000]]);
    expect(buildLagSnapshot(five, 5, 'aof_replicating', NOW).fullySynced).toBe(true);
  });

  it('is not fully synced when a reported extra shard is stale or lagging', () => {
    const map = mapOf([['src-0', 0, NOW], ['src-1', 0, NOW], ['src-2', 0, NOW - 60_000]]);
    expect(buildLagSnapshot(map, 2, 'aof_replicating', NOW).fullySynced).toBe(false);
  });
});

describe('countSourceShards', () => {
  it('returns 1 for a standalone source without querying nodes', async () => {
    const getClusterNodes = jest.fn();
    await expect(countSourceShards({ getClusterNodes }, false)).resolves.toBe(1);
    expect(getClusterNodes).not.toHaveBeenCalled();
  });

  it('counts master nodes for a cluster source', async () => {
    const getClusterNodes = jest.fn().mockResolvedValue([
      { flags: ['myself', 'master'], slots: [[0, 5460]] },
      { flags: ['master'], slots: [[5461, 10922]] },
      { flags: ['slave'], slots: [] },
      { flags: ['master'], slots: [[10923, 16383]] },
    ]);
    await expect(countSourceShards({ getClusterNodes }, true)).resolves.toBe(3);
  });

  it('skips masters that hold no slots, as RedisShake does', async () => {
    const getClusterNodes = jest.fn().mockResolvedValue([
      { flags: ['master'], slots: [[0, 8191]] },
      { flags: ['master'], slots: [[8192, 16383]] },
      { flags: ['master'], slots: [] },
    ]);
    await expect(countSourceShards({ getClusterNodes }, true)).resolves.toBe(2);
  });

  it('returns null when topology lookup throws', async () => {
    const getClusterNodes = jest.fn().mockRejectedValue(new Error('NOPERM'));
    await expect(countSourceShards({ getClusterNodes }, true)).resolves.toBeNull();
  });

  it('returns null when no masters are found', async () => {
    const getClusterNodes = jest.fn().mockResolvedValue([{ flags: ['slave'], slots: [] }]);
    await expect(countSourceShards({ getClusterNodes }, true)).resolves.toBeNull();
  });
});
