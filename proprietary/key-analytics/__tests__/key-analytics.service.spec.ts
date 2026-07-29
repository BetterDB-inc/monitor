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

function makeService(getHotKeys: jest.Mock): KeyAnalyticsService {
  const storage = { getHotKeys } as unknown as StoragePort;
  const registry = {} as unknown as ConnectionRegistry;
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
});

describe('KeyAnalyticsService.collect composite persistence', () => {
  function makeCollectService(saveHotKeys: jest.Mock): {
    service: KeyAnalyticsService;
    client: { collectKeyAnalytics: jest.Mock };
  } {
    const client = {
      collectKeyAnalytics: jest.fn().mockResolvedValue({
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
      }),
    };
    const storage = {
      saveHotKeys,
      saveKeyPatternSnapshots: jest.fn().mockResolvedValue(undefined),
    } as unknown as StoragePort;
    const registry = {} as unknown as ConnectionRegistry;
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
