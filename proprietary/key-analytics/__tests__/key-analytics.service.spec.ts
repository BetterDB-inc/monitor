import { KeyAnalyticsService } from '../key-analytics.service';
import type { HotKeyEntry, HotKeyQueryOptions } from '@betterdb/shared';
import type { ConnectionRegistry } from '@app/connections/connection-registry.service';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import type { LicenseService } from '@proprietary/licenses';

function hotKey(over: Partial<HotKeyEntry>): HotKeyEntry {
  return {
    id: 'id',
    keyName: 'k',
    connectionId: 'c1',
    capturedAt: 0,
    signalType: 'composite',
    rank: 1,
    ...over,
  };
}

function makeService(getHotKeys: jest.Mock, getHotKeyDatabases?: jest.Mock): KeyAnalyticsService {
  const storage = {
    getHotKeys,
    getHotKeyDatabases: getHotKeyDatabases ?? jest.fn(async () => [0]),
  } as unknown as StoragePort;
  const registry = { list: () => [] } as unknown as ConnectionRegistry;
  const license = {
    hasFeature: () => true,
    getLicenseTier: () => 'pro',
  } as unknown as LicenseService;
  return new KeyAnalyticsService(registry, storage, license);
}

const isCompositeOnly = (opts: HotKeyQueryOptions) =>
  opts.signalTypes?.length === 1 && opts.signalTypes[0] === 'composite';

describe('KeyAnalyticsService.getCompositeKeys freshness guard', () => {
  it('returns the composite batch when it is from the latest collection', async () => {
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts)
        ? [hotKey({ capturedAt: 1000, keyName: 'a' })]
        : [hotKey({ capturedAt: 1000, signalType: 'cardinality' })],
    );

    const res = await makeService(getHotKeys).getCompositeKeys({ connectionId: 'c1', latest: true });

    expect(res.map((r) => r.keyName)).toEqual(['a']);
  });

  it('returns empty when a newer collection produced no composite keys', async () => {
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts)
        ? [hotKey({ capturedAt: 1000, keyName: 'stale' })] // old composite batch
        : [hotKey({ capturedAt: 2000, signalType: 'cardinality' })], // newer scan, no composites
    );

    const res = await makeService(getHotKeys).getCompositeKeys({ connectionId: 'c1', latest: true });

    expect(res).toEqual([]);
  });

  it('does not apply the freshness guard for unscoped (all-connections) queries', async () => {
    // Across connections a shared capturedAt does not hold: connection A collecting
    // later with no composites must not suppress connection B's valid batch.
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts)
        ? [hotKey({ capturedAt: 1000, keyName: 'b-composite', connectionId: 'B' })]
        : [hotKey({ capturedAt: 2000, signalType: 'cardinality', connectionId: 'A' })],
    );

    const service = makeService(getHotKeys);
    const res = await service.getCompositeKeys({ latest: true }); // no connectionId

    expect(res.map((r) => r.keyName)).toEqual(['b-composite']);
    // No cross-connection freshness lookup for unscoped queries.
    expect(getHotKeys).toHaveBeenCalledTimes(1);
  });

  it('does not apply the freshness guard for explicit time ranges', async () => {
    const getHotKeys = jest.fn(async () => [hotKey({ capturedAt: 1000, keyName: 'ranged' })]);

    const service = makeService(getHotKeys);
    const res = await service.getCompositeKeys({
      connectionId: 'c1',
      latest: true,
      startTime: 1,
      endTime: 5,
    });

    expect(res.map((r) => r.keyName)).toEqual(['ranged']);
    // No second lookup for the latest-collection timestamp.
    expect(getHotKeys).toHaveBeenCalledTimes(1);
  });

  it('applies the freshness guard per database so a sibling\'s newer scan does not suppress valid composites', async () => {
    // db0 last produced composites at t=1000 and was not rescanned since; db1 was
    // rescanned at t=2000 with no composites. Per-db pinned queries keep the two
    // independent, so db1's newer scan cannot blank db0's still-valid composites.
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) => {
      if (isCompositeOnly(opts)) {
        return opts.db === 0
          ? [hotKey({ capturedAt: 1000, keyName: 'db0-composite', db: 0 })]
          : [];
      }
      return opts.db === 0
        ? [hotKey({ capturedAt: 1000, signalType: 'lfu', db: 0 })]
        : [hotKey({ capturedAt: 2000, signalType: 'lfu', db: 1 })];
    });

    const res = await makeService(getHotKeys, jest.fn(async () => [0, 1])).getCompositeKeys({
      connectionId: 'c1',
      latest: true,
    });

    expect(res.map((r) => r.keyName)).toEqual(['db0-composite']);
  });

  it('still applies the freshness guard for a db-filtered latest read', async () => {
    // A db-filtered latest read must not serve stale composites when that db's
    // latest scan produced none (regression: the guard used to be skipped unless
    // the db was unset).
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts)
        ? [hotKey({ capturedAt: 1000, keyName: 'stale', db: 3 })]
        : [hotKey({ capturedAt: 2000, signalType: 'lfu', db: 3 })],
    );

    const res = await makeService(getHotKeys).getCompositeKeys({
      connectionId: 'c1',
      latest: true,
      db: 3,
    });

    expect(res).toEqual([]);
  });

  it('reads each database\'s oldest composite capture via a pinned oldest query', async () => {
    // oldest (baseline) reads must use a per-db pinned MIN(captured_at) query, not
    // the minimum within a newest-first, cap-truncated window.
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts) ? [hotKey({ capturedAt: 100, keyName: 'old', db: 0 })] : [],
    );

    const res = await makeService(getHotKeys).getCompositeKeys({ connectionId: 'c1', oldest: true });

    expect(res.map((r) => r.keyName)).toEqual(['old']);
    const compositeCall = getHotKeys.mock.calls.find((call) => isCompositeOnly(call[0]));
    expect(compositeCall?.[0]).toMatchObject({ db: 0, oldest: true });
    expect(compositeCall?.[0].latest).toBeFalsy();
  });

  it('merges every database\'s composites and re-ranks globally by composite score (not per-db-rank interleave)', async () => {
    // db1's composite is weakly composite; db0's has a far higher composite score.
    // Stored per-db ranks would interleave db1 first; the read must re-rank by a
    // cross-db-comparable composite score (db0 first), keep both, and renumber.
    const composites = [
      hotKey({ keyName: 'd1-weak', db: 1, capturedAt: 1000, freqScore: 10, cardinality: 10 }),
      hotKey({ keyName: 'd0-strong', db: 0, capturedAt: 1000, freqScore: 100, cardinality: 100 }),
    ];
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts)
        ? composites.filter((c) => c.db === opts.db)
        : [hotKey({ capturedAt: 1000, signalType: 'lfu', db: opts.db })],
    );

    const res = await makeService(getHotKeys, jest.fn(async () => [0, 1])).getCompositeKeys({
      connectionId: 'c1',
      latest: true,
    });

    expect(res.map((r) => r.keyName)).toEqual(['d0-strong', 'd1-weak']);
    expect(res.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('keeps a database\'s latest composites when a sibling has a newer composite capture (per-db latest)', async () => {
    // Partial scan: db0's latest composite capture is t=1000, db1's is t=2000. A
    // single global `latest` pin keeps only db1 (MAX=2000); per-db pinned queries
    // keep db0's t=1000 composite too.
    const composites = [
      hotKey({ keyName: 'd1-key', db: 1, capturedAt: 2000, freqScore: 50, cardinality: 50 }),
      hotKey({ keyName: 'd0-key', db: 0, capturedAt: 1000, freqScore: 90, cardinality: 90 }),
    ];
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts)
        ? composites.filter((c) => c.db === opts.db)
        : [hotKey({ capturedAt: opts.db === 0 ? 1000 : 2000, signalType: 'lfu', db: opts.db })],
    );

    const res = await makeService(getHotKeys, jest.fn(async () => [0, 1])).getCompositeKeys({
      connectionId: 'c1',
      latest: true,
    });

    expect(res.map((r) => r.keyName).sort()).toEqual(['d0-key', 'd1-key']);
  });
});

describe('KeyAnalyticsService.getHotKeys global re-rank', () => {
  it('re-ranks merged per-db rows by hotness and renumbers, instead of truncating by per-db rank', async () => {
    // db0 holds the two hottest keys (freq 200, 190 at per-db ranks 1, 2); db1
    // holds cooler keys (freq 50, 40 at per-db ranks 1, 2). Stored rows are
    // interleaved by per-db rank, so a naive storage limit:2 would return
    // db0#1 + db1#1 and drop db0#2. The service must fetch the whole capture,
    // re-rank by freqScore, and renumber 1..N.
    const stored = [
      hotKey({ keyName: 'd0a', signalType: 'lfu', freqScore: 200, rank: 1, db: 0 }),
      hotKey({ keyName: 'd1a', signalType: 'lfu', freqScore: 50, rank: 1, db: 1 }),
      hotKey({ keyName: 'd0b', signalType: 'lfu', freqScore: 190, rank: 2, db: 0 }),
      hotKey({ keyName: 'd1b', signalType: 'lfu', freqScore: 40, rank: 2, db: 1 }),
    ];
    const getHotKeys = jest.fn(async (_opts: HotKeyQueryOptions) => stored);

    const res = await makeService(getHotKeys).getHotKeys({
      connectionId: 'c1',
      latest: true,
      limit: 2,
    });

    expect(res.map((r) => r.keyName)).toEqual(['d0a', 'd0b']);
    expect(res.map((r) => r.rank)).toEqual([1, 2]);
    // Fetched the full capture (a cap), not the caller's small limit.
    const passedLimit = getHotKeys.mock.calls[0]?.[0]?.limit;
    expect(passedLimit ?? 0).toBeGreaterThan(2);
  });

  it('on a multi-snapshot range read dedupes each key to its hottest observation, not its largest-memory one', async () => {
    // Same key in two snapshots: hotter one (freq 500) has small memory, the
    // cooler one (freq 10) has huge memory. A memory-based dedupe would keep the
    // freq-10 row; this surface ranks by hotness, so it must keep freq 500.
    const stored = [
      hotKey({ keyName: 'k', db: 0, signalType: 'lfu', freqScore: 500, memoryBytes: 10, capturedAt: 1 }),
      hotKey({ keyName: 'k', db: 0, signalType: 'lfu', freqScore: 10, memoryBytes: 9999, capturedAt: 2 }),
    ];
    const getHotKeys = jest.fn(async (_opts: HotKeyQueryOptions) => stored);

    // No latest/oldest -> multi-snapshot path (singleSnapshot = false).
    const res = await makeService(getHotKeys).getHotKeys({
      connectionId: 'c1',
      startTime: 1,
      endTime: 9,
    });

    expect(res).toHaveLength(1);
    expect(res[0].freqScore).toBe(500);
  });
});

describe('KeyAnalyticsService.collect composite persistence', () => {
  function makeCollectService(saveHotKeys: jest.Mock): {
    service: KeyAnalyticsService;
    client: { collectKeyAnalytics: jest.Mock };
  } {
    const client = {
      // One result per scanned logical database.
      collectKeyAnalytics: jest.fn().mockResolvedValue([{
        dbSize: 3,
        scanned: 3,
        patterns: [],
        keyDetails: [
          // Extreme on both hotness (freq) and cardinality -> the only composite.
          { keyName: 'hotbig', keyType: 'hash', freqScore: 250, idleSeconds: null, memoryBytes: 1000, cardinality: 5000, ttl: null },
          // Hot but zero cardinality -> hotness dimension only, not composite.
          { keyName: 'onlyhot', keyType: 'string', freqScore: 240, idleSeconds: null, memoryBytes: 20, cardinality: null, ttl: null },
          // Big but LFU-cold (freq 0 is dropped) -> cardinality dimension only.
          { keyName: 'onlybig', keyType: 'hash', freqScore: 0, idleSeconds: null, memoryBytes: 900, cardinality: 4000, ttl: null },
        ],
      }]),
    };
    const storage = {
      saveHotKeys,
      saveKeyPatternSnapshots: jest.fn().mockResolvedValue(undefined),
    } as unknown as StoragePort;
    const registry = { list: () => [] } as unknown as ConnectionRegistry;
    const license = {
      hasFeature: () => true,
      getLicenseTier: () => 'pro',
    } as unknown as LicenseService;
    return { service: new KeyAnalyticsService(registry, storage, license), client };
  }

  async function runCollect(service: KeyAnalyticsService, client: unknown): Promise<void> {
    const ctx = { connectionId: 'c1', connectionName: 'c1', client };
    await (
      service as unknown as { collect(ctx: unknown, fullScan: boolean): Promise<void> }
    ).collect(ctx, true);
  }

  it('persists hot, largest, and composite rows in ONE atomic saveHotKeys call', async () => {
    const saveHotKeys = jest.fn().mockResolvedValue(undefined);
    const { service, client } = makeCollectService(saveHotKeys);

    await runCollect(service, client);

    // The atomicity guarantee: all three signal groups land in a single write,
    // scoped to the connection — never a per-group call that could expose a
    // half-written capturedAt to the composite freshness guard.
    expect(saveHotKeys).toHaveBeenCalledTimes(1);
    const rows = saveHotKeys.mock.calls[0][0] as HotKeyEntry[];
    const connectionId = saveHotKeys.mock.calls[0][1] as string;
    expect(connectionId).toBe('c1');

    const signalTypes = new Set(rows.map((r) => r.signalType));
    expect(signalTypes).toEqual(new Set(['lfu', 'cardinality', 'composite']));
  });

  it('maps a ranked composite key onto a composite HotKeyEntry', async () => {
    const saveHotKeys = jest.fn().mockResolvedValue(undefined);
    const { service, client } = makeCollectService(saveHotKeys);

    await runCollect(service, client);

    const rows = saveHotKeys.mock.calls[0][0] as HotKeyEntry[];
    const composites = rows.filter((r) => r.signalType === 'composite');

    // Only 'hotbig' is extreme on both dimensions; the mapping carries the raw
    // hotness signal (freqScore), cardinality, and memory context through.
    expect(composites).toHaveLength(1);
    expect(composites[0]).toMatchObject({
      keyName: 'hotbig',
      connectionId: 'c1',
      signalType: 'composite',
      freqScore: 250,
      cardinality: 5000,
      memoryBytes: 1000,
      keyType: 'hash',
      rank: 1,
    });
    expect(typeof composites[0].capturedAt).toBe('number');
  });
});

describe('external connections', () => {
  const statuses = [
    { id: 'ext', name: 'pushed', host: 'a', port: 1, isConnected: true, connectionType: 'external' },
    { id: 'dir', name: 'polled', host: 'b', port: 2, isConnected: true, connectionType: 'direct' },
  ];

  it('skips external connections in triggerCollection', async () => {
    const registry = { list: jest.fn().mockReturnValue(statuses), get: jest.fn().mockReturnValue({}) };
    const service = new KeyAnalyticsService(registry as never, {} as never, {} as never);
    const collect = jest.spyOn(service as any, 'collect').mockResolvedValue(undefined);
    await service.triggerCollection();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0][0]).toMatchObject({ connectionId: 'dir' });
  });

  it('never defaults getKeySizes to an external connection', async () => {
    const client = { call: jest.fn().mockResolvedValue('') };
    const registry = { list: jest.fn().mockReturnValue(statuses), get: jest.fn().mockReturnValue(client) };
    const service = new KeyAnalyticsService(registry as never, {} as never, {} as never);
    await service.getKeySizes();
    expect(registry.get).toHaveBeenCalledWith('dir');
  });
});
