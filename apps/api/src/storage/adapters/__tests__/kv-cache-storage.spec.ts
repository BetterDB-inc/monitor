import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Pool } from 'pg';
import { SqliteAdapter } from '../sqlite.adapter';
import * as sqliteChunkedDelete from '../sqlite-chunked-delete';
import { MemoryAdapter } from '../memory.adapter';
import { PostgresAdapter } from '../postgres.adapter';
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
  primariesScanned: 1,
  primariesTotal: 3,
  chunksEst: 10,
  bytesEst: 36_701_120,
  usedMemory: 40_000_000,
  maxmemory: 0,
  maxmemoryPolicy: 'noeviction',
  lmcacheMemoryShare: 0.92,
  noTtlRatio: 1,
  orphanRatio: null,
  evictedKeysDelta: null,
  evictedKeysIntervalMs: null,
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

const POSTGRES_DSN =
  process.env.KV_CACHE_POSTGRES_TEST_DSN ?? 'postgres://betterdb:devpassword@localhost:5433/betterdb';

function isReachable(connectionString: string): boolean {
  const { hostname, port } = new URL(connectionString);
  const probe = `
    const socket = require('net').createConnection({ host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT) });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => { process.exit(1); });
  `;
  try {
    execFileSync(process.execPath, ['-e', probe], {
      stdio: 'ignore',
      timeout: 3000,
      env: { ...process.env, PROBE_HOST: hostname, PROBE_PORT: port || '5432' },
    });
    return true;
  } catch {
    return false;
  }
}

type AdapterFactory = () => Promise<{ storage: StoragePort; cleanup: () => Promise<void> }>;

const postgresAdapters: Array<[string, AdapterFactory]> = isReachable(POSTGRES_DSN)
  ? [
      [
        'postgres',
        async () => {
          const schema = `kv_cache_${randomUUID().replace(/-/g, '')}`;
          const storage = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
          await storage.initialize();
          return {
            storage: storage as StoragePort,
            cleanup: async () => {
              await storage.close();
              const pool = new Pool({ connectionString: POSTGRES_DSN });
              try {
                await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
              } finally {
                await pool.end();
              }
            },
          };
        },
      ],
    ]
  : [];

describe.each<[string, AdapterFactory]>([
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
  ...postgresAdapters,
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

  it('round-trips an eviction delta with the interval it covers', async () => {
    await storage.saveKvCacheFootprintSnapshot(snapshot({ evictedKeysDelta: 12, evictedKeysIntervalMs: 300_000 }));
    expect((await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a' }))[0]).toMatchObject({
      evictedKeysDelta: 12,
      evictedKeysIntervalMs: 300_000,
    });
  });

  it('round-trips a snapshot without a TTL ratio', async () => {
    await storage.saveKvCacheFootprintSnapshot(snapshot({ noTtlRatio: null }));
    expect((await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a' }))[0].noTtlRatio).toBeNull();
  });

  it('round-trips a snapshot whose byte estimate is unknown', async () => {
    const unknown = snapshot({
      bytesEst: null,
      lmcacheMemoryShare: null,
      primariesTotal: null,
      perModel: [{ model: 'm', dtype: 'half', chunksEst: 10, bytesEst: null }],
    });
    await storage.saveKvCacheFootprintSnapshot(unknown);
    expect(await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a' })).toEqual([unknown]);
  });

  it('returns the newest snapshots in ascending order when limited', async () => {
    for (const timestamp of [1, 2, 3]) await storage.saveKvCacheFootprintSnapshot(snapshot({ timestamp }));
    const rows = await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a', limit: 2 });
    expect(rows.map((r) => r.timestamp)).toEqual([2, 3]);
  });

  it('keeps the latest snapshot per time bucket when bucketing', async () => {
    for (const timestamp of [100, 105, 109, 110, 125, 139, 140, 200]) {
      await storage.saveKvCacheFootprintSnapshot(snapshot({ timestamp }));
    }
    await storage.saveKvCacheFootprintSnapshot(snapshot({ timestamp: 150, connectionId: 'conn-b' }));
    const rows = await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a', from: 100, to: 199, bucketMs: 10 });
    expect(rows.map((r) => r.timestamp)).toEqual([109, 110, 125, 139, 140]);
    expect(rows[0]).toEqual(snapshot({ timestamp: 109 }));
    const limited = await storage.getKvCacheFootprintSnapshots({ connectionId: 'conn-a', from: 100, to: 199, bucketMs: 10, limit: 2 });
    expect(limited.map((r) => r.timestamp)).toEqual([139, 140]);
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

  it('keeps the identity of an engine on re-save and returns the stored row', async () => {
    await storage.saveKvCacheEngine(engine());
    const saved = await storage.saveKvCacheEngine(
      engine({ connectionId: 'conn-b', source: 'otlp', createdAt: 99, name: 'renamed', lastSeenAt: 5 }),
    );
    const expected = engine({ name: 'renamed', lastSeenAt: 5 });
    expect(saved).toEqual(expected);
    expect(await storage.getKvCacheEngine('eng-1')).toEqual(expected);
    expect(await storage.getKvCacheEngines('conn-b')).toEqual([]);
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

describe('postgres adapter kv cache storage before initialize', () => {
  it('rejects engine samples instead of dropping them', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://unused' });
    await expect(adapter.saveKvCacheEngineSamples([sample()])).rejects.toThrow('Database not initialized');
  });
});

describe('sqlite adapter kv cache connection cleanup', () => {
  it('deletes each table in bounded chunks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-cache-'));
    const storage = new SqliteAdapter({ filepath: path.join(dir, 'db.sqlite') });
    await storage.initialize();
    const chunked = jest.spyOn(sqliteChunkedDelete, 'chunkedSqliteDelete');
    try {
      await storage.deleteKvCacheConnectionData('conn-a');
      expect(chunked.mock.calls.map(([, table]) => table)).toEqual([
        'kv_cache_footprint_snapshots',
        'kv_cache_engine_samples',
        'kv_cache_engines',
        'kv_cache_settings',
      ]);
      expect(chunked.mock.calls.every(([, , where, params]) => where === 'connection_id = ?' && params[0] === 'conn-a')).toBe(true);
    } finally {
      chunked.mockRestore();
      await storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
