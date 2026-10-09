import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteAdapter } from '../sqlite.adapter';
import { MemoryAdapter } from '../memory.adapter';
import type { KvCacheEngineSample, KvCacheFootprintSnapshot } from '@betterdb/shared';
import type { StoragePort, StoredKvCacheEngine } from '../../../common/interfaces/storage-port.interface';

const snapshot = (o: Partial<KvCacheFootprintSnapshot> = {}): KvCacheFootprintSnapshot => ({
  connectionId: 'conn-a',
  timestamp: 1_000,
  detected: true,
  layout: 'single_key',
  scannedKeys: 100,
  matchedKeys: 10,
  sampledKeys: 10,
  scanComplete: true,
  chunksEst: 10,
  bytesEst: 36_701_120,
  usedMemory: 40_000_000,
  maxmemory: 0,
  maxmemoryPolicy: 'noeviction',
  lmcacheMemoryShare: 0.92,
  noTtlRatio: 1,
  orphanRatio: null,
  evictedKeysDelta: null,
  otherDbs: [2],
  perModel: [{ model: 'Qwen/Qwen2.5-0.5B-Instruct', dtype: 'bfloat16', chunksEst: 10, bytesEst: 36_701_120 }],
  ...o,
});

const sample = (o: Partial<KvCacheEngineSample> = {}): KvCacheEngineSample => ({
  engineId: 'eng-1',
  connectionId: 'conn-a',
  modelName: 'm',
  timestamp: 60_000,
  requestedTokens: 1000,
  hitTokens: 700,
  lookupTokens: 1000,
  lookupHits: 3,
  remoteReadBytes: 10,
  remoteWriteBytes: 20,
  remoteReadRequests: 1,
  remoteWriteRequests: 2,
  remotePingErrors: 0,
  ...o,
});

const engine = (o: Partial<StoredKvCacheEngine> = {}): StoredKvCacheEngine => ({
  id: 'eng-1',
  connectionId: 'conn-a',
  name: 'vllm-0',
  source: 'scrape',
  scrapeUrl: 'http://vllm:8000/metrics',
  scrapeAuthHeader: null,
  scrapeAuthEncrypted: false,
  otlpEngineId: null,
  enabled: true,
  createdAt: 1,
  lastSeenAt: null,
  lastError: null,
  ...o,
});

describe.each([
  ['memory', async () => {
    const storage = new MemoryAdapter();
    await storage.initialize();
    return { storage: storage as StoragePort, cleanup: async () => storage.close() };
  }],
  ['sqlite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-cache-'));
    const storage = new SqliteAdapter({ filepath: path.join(dir, 'db.sqlite') });
    await storage.initialize();
    return {
      storage: storage as StoragePort,
      cleanup: async () => {
        await storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }],
])('%s adapter kv cache storage', (_name, make) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await make());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('round-trips a footprint snapshot', async () => {
    await storage.saveKvCacheFootprintSnapshot(snapshot());
    expect(await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a' })).toEqual([snapshot()]);
  });

  it('returns the newest snapshots in ascending order when limited', async () => {
    for (const timestamp of [1, 2, 3]) await storage.saveKvCacheFootprintSnapshot(snapshot({ timestamp }));
    const rows = await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a', limit: 2 });
    expect(rows.map((r) => r.timestamp)).toEqual([2, 3]);
  });

  it('prunes snapshots by cutoff and optionally by connection', async () => {
    await storage.saveKvCacheFootprintSnapshot(snapshot({ timestamp: 1 }));
    await storage.saveKvCacheFootprintSnapshot(snapshot({ timestamp: 1, connectionId: 'conn-b' }));
    await storage.saveKvCacheFootprintSnapshot(snapshot({ timestamp: 5 }));
    expect(await storage.pruneOldKvCacheFootprintSnapshots(2, 'conn-a')).toBe(1);
    expect(await storage.pruneOldKvCacheFootprintSnapshots(2)).toBe(1);
    expect((await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a' })).map((r) => r.timestamp)).toEqual([5]);
  });

  it('filters samples by engine, model and range', async () => {
    await storage.saveKvCacheEngineSamples([
      sample(),
      sample({ engineId: 'eng-2' }),
      sample({ modelName: 'other' }),
      sample({ timestamp: 999_999 }),
    ]);
    const rows = await storage.getKvCacheEngineSamples({
      connectionId: 'conn-a',
      engineId: 'eng-1',
      modelName: 'm',
      from: 0,
      to: 100_000,
    });
    expect(rows).toEqual([sample()]);
  });

  it('prunes samples', async () => {
    await storage.saveKvCacheEngineSamples([sample({ timestamp: 1 }), sample({ timestamp: 10 })]);
    expect(await storage.pruneOldKvCacheEngineSamples(5)).toBe(1);
  });

  it('deletes the samples of one engine only', async () => {
    await storage.saveKvCacheEngineSamples([
      sample({ timestamp: 60_000 }),
      sample({ timestamp: 120_000 }),
      sample({ engineId: 'eng-2', timestamp: 60_000 }),
    ]);
    await storage.deleteKvCacheEngineSamples('eng-1');
    const rows = await storage.getKvCacheEngineSamples({ connectionId: 'conn-a' });
    expect(rows.map((r) => r.engineId)).toEqual(['eng-2']);
  });

  it('upserts, lists, reads and deletes engines', async () => {
    await storage.saveKvCacheEngine(engine());
    await storage.saveKvCacheEngine(engine({ id: 'eng-2', source: 'otlp', scrapeUrl: null, otlpEngineId: 'lmc-1', createdAt: 2 }));
    await storage.saveKvCacheEngine(engine({ name: 'renamed', lastSeenAt: 9, lastError: 'HTTP 401' }));
    expect((await storage.getKvCacheEngines('conn-a')).map((e) => e.name)).toEqual(['renamed', 'vllm-0']);
    expect(await storage.getKvCacheEngine('eng-2')).toEqual(
      engine({ id: 'eng-2', source: 'otlp', scrapeUrl: null, otlpEngineId: 'lmc-1', createdAt: 2 }),
    );
    expect(await storage.deleteKvCacheEngine('eng-2')).toBe(true);
    expect(await storage.deleteKvCacheEngine('eng-2')).toBe(false);
    expect(await storage.getKvCacheEngine('eng-2')).toBeNull();
  });

  it('upserts settings', async () => {
    expect(await storage.getKvCacheSettings('conn-a')).toBeNull();
    const settings = { connectionId: 'conn-a', hitRateAlertEnabled: false, hitRateThreshold: 0.35, evictionAlertEnabled: true, updatedAt: 7 };
    await storage.saveKvCacheSettings(settings);
    await storage.saveKvCacheSettings({ ...settings, hitRateThreshold: 0.4 });
    expect(await storage.getKvCacheSettings('conn-a')).toEqual({ ...settings, hitRateThreshold: 0.4 });
  });

  it('deletes everything for a connection', async () => {
    await storage.saveKvCacheFootprintSnapshot(snapshot());
    await storage.saveKvCacheEngineSamples([sample()]);
    await storage.saveKvCacheEngine(engine());
    await storage.saveKvCacheSettings({ connectionId: 'conn-a', hitRateAlertEnabled: true, hitRateThreshold: 0.2, evictionAlertEnabled: true, updatedAt: 1 });
    await storage.saveKvCacheFootprintSnapshot(snapshot({ connectionId: 'conn-b' }));
    await storage.deleteKvCacheConnectionData('conn-a');
    expect(await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a' })).toEqual([]);
    expect(await storage.getKvCacheEngineSamples({ connectionId: 'conn-a' })).toEqual([]);
    expect(await storage.getKvCacheEngines('conn-a')).toEqual([]);
    expect(await storage.getKvCacheSettings('conn-a')).toBeNull();
    expect(await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-b' })).toHaveLength(1);
  });
});
