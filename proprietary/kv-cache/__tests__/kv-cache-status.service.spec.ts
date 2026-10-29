import { Feature } from '@betterdb/shared';
import { KvCacheFootprintService } from '../kv-cache-footprint.service';
import { KvCacheStatusService, toPublicEngine } from '../kv-cache-status.service';

const engine = {
  id: 'e1', connectionId: 'c1', name: 'vllm', source: 'scrape', scrapeUrl: 'http://x/metrics',
  scrapeAuthHeader: 'enc', scrapeAuthEncrypted: true, otlpEngineId: null, enabled: true,
  createdAt: 1, lastSeenAt: 2, lastError: null,
} as const;

describe('KvCacheStatusService', () => {
  const storage = {
    getKvCacheFootprintSnapshots: jest.fn(),
  } as any;
  const registry = { list: jest.fn().mockReturnValue([engine]) } as any;
  const footprint = {
    getSampleKey: jest.fn().mockReturnValue('m@1@0@abc…@bfloat16'),
    getFootprintIntervalMs: jest.fn().mockReturnValue(300000),
    getLastScanAttempt: jest.fn().mockReturnValue(null),
  } as any;
  const service = new KvCacheStatusService(storage, footprint, registry);

  it('never exposes the auth header', () => {
    const pub = toPublicEngine(engine as any);
    expect(pub).not.toHaveProperty('scrapeAuthHeader');
    expect(pub).not.toHaveProperty('scrapeAuthEncrypted');
    expect(pub.hasScrapeAuth).toBe(true);
  });

  it.each([
    ['http://user:s3cret@vllm:8000/metrics', 'http://***@vllm:8000/metrics'],
    ['https://token@vllm/metrics?x=1', 'https://***@vllm/metrics?x=***'],
    ['http://vllm:8000/metrics', 'http://vllm:8000/metrics'],
    ['http://vllm:8000/metrics?next=a@b', 'http://vllm:8000/metrics?next=***'],
  ])('masks userinfo in scrape URL %s', (scrapeUrl, expected) => {
    expect(toPublicEngine({ ...engine, scrapeUrl } as any).scrapeUrl).toBe(expected);
  });

  it('masks query values in the scrape URL', () => {
    expect(toPublicEngine({ ...engine, scrapeUrl: 'http://vllm:8000/metrics?token=s3cret&format=text' } as any).scrapeUrl).toBe(
      'http://vllm:8000/metrics?token=***&format=***',
    );
    expect(toPublicEngine({ ...engine, scrapeUrl: 'http://admin:pw@vllm/metrics?key=abc#frag' } as any).scrapeUrl).toBe('http://***@vllm/metrics?key=***');
    expect(toPublicEngine({ ...engine, scrapeUrl: 'http://vllm/metrics?flag&empty=' } as any).scrapeUrl).toBe('http://vllm/metrics?flag&empty=');
  });

  it('keeps a null scrape URL null', () => {
    expect(toPublicEngine({ ...engine, scrapeUrl: null } as any).scrapeUrl).toBeNull();
  });

  it('does not touch the stored engine when masking', () => {
    const stored = { ...engine, scrapeUrl: 'http://u:p@h/metrics' };
    toPublicEngine(stored as any);
    expect(stored.scrapeUrl).toBe('http://u:p@h/metrics');
  });

  it('builds status from the latest two snapshots', async () => {
    const previous = { detected: true, timestamp: 1 };
    const latest = { detected: true, timestamp: 2 };
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([previous, latest]);
    const status = await service.getStatus('c1');
    expect(storage.getKvCacheFootprintSnapshots).toHaveBeenCalledWith({ connectionId: 'c1', limit: 2 });
    expect(registry.list).toHaveBeenCalledWith('c1');
    expect(status).toEqual({
      hasLmcache: true,
      latest,
      recent: [previous, latest],
      footprintIntervalMs: 300000,
      sampleKey: 'm@1@0@abc…@bfloat16',
      engines: [toPublicEngine(engine as any)],
      lastScanAttemptAt: null,
      lastScanError: null,
    });
  });

  it('uses the only snapshot as latest', async () => {
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([{ detected: false, timestamp: 1 }]);
    const status = await service.getStatus('c1');
    expect(status.latest).toEqual({ detected: false, timestamp: 1 });
    expect(status.recent).toHaveLength(1);
    expect(status.hasLmcache).toBe(false);
  });

  it('reports not detected without a snapshot', async () => {
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([]);
    expect((await service.getStatus('c1')).hasLmcache).toBe(false);
  });

  it('reports a failing scheduled scan and clears it once a scan succeeds', async () => {
    const keys = ['m/x@1@0@1@bfloat16', 'm/x@1@0@2@bfloat16', 'm/x@1@0@3@bfloat16'];
    let denied = true;
    const client = {
      getDbSize: jest.fn().mockResolvedValue(keys.length),
      call: jest.fn(async (cmd: string) => {
        if (cmd === 'SCAN') {
          if (denied) throw new Error("NOPERM User monitor has no permissions to run the 'scan' command");
          return ['0', keys];
        }
        return { MEMORY: 100, TTL: -1, EXISTS: 0, CLIENT: '' }[cmd];
      }),
      getClient: () => {
        throw new Error('no raw client');
      },
      getInfoParsed: jest.fn().mockResolvedValue({
        memory: { used_memory: '1000', maxmemory: '0', maxmemory_policy: 'noeviction' },
        stats: { evicted_keys: '0' },
        keyspace: { db0: { keys: keys.length, expires: 0, avg_ttl: 0 } },
      }),
      getRole: jest.fn().mockResolvedValue({ role: 'master' }),
    };
    const connections = {
      list: jest.fn().mockReturnValue([{ id: 'c1', name: 'one', isConnected: true, connectionType: 'direct' }]),
      get: jest.fn().mockReturnValue(client),
      getConfig: jest.fn().mockReturnValue({ id: 'c1', name: 'one', host: 'h', port: 6379, dbIndex: 0 }),
    } as any;
    const store = {
      saveKvCacheFootprintSnapshot: jest.fn(),
      getKvCacheFootprintSnapshots: jest.fn().mockResolvedValue([]),
    } as any;
    const license = { hasFeature: (feature: string) => feature === Feature.KV_CACHE_MONITORING } as any;
    const realFootprint = new KvCacheFootprintService(connections, store, license);
    const statuses = new KvCacheStatusService(store, realFootprint, { list: () => [] } as any);
    const poll = () =>
      (realFootprint as any)
        .pollConnection({ connectionId: 'c1', connectionName: 'one', client, host: 'h', port: 6379 })
        .catch(() => undefined);

    const before = Date.now();
    await poll();
    const failing = await statuses.getStatus('c1');
    expect(failing.latest).toBeNull();
    expect(failing.lastScanError).toMatch(/NOPERM/);
    expect(failing.lastScanAttemptAt).toBeGreaterThanOrEqual(before);

    denied = false;
    await poll();
    const recovered = await statuses.getStatus('c1');
    expect(recovered.lastScanError).toBeNull();
    expect(recovered.lastScanAttemptAt).toBeNull();
  });

  it('reports a disconnected connection with no snapshot as a failed scan', async () => {
    const connections = {
      list: jest.fn().mockReturnValue([{ id: 'c1', name: 'one', isConnected: false, connectionType: 'direct' }]),
      get: jest.fn().mockReturnValue({}),
      getConfig: jest.fn().mockReturnValue({ id: 'c1', name: 'one', host: 'h', port: 6379, dbIndex: 0 }),
    } as any;
    const store = {
      saveKvCacheFootprintSnapshot: jest.fn(),
      getKvCacheFootprintSnapshots: jest.fn().mockResolvedValue([]),
    } as any;
    const license = { hasFeature: (feature: string) => feature === Feature.KV_CACHE_MONITORING } as any;
    const realFootprint = new KvCacheFootprintService(connections, store, license);
    const statuses = new KvCacheStatusService(store, realFootprint, { list: () => [] } as any);

    await (realFootprint as any).tick();
    const status = await statuses.getStatus('c1');
    expect(status.latest).toBeNull();
    expect(status.lastScanError).toBe("Connection 'c1' is not connected");
    expect(status.lastScanAttemptAt).toEqual(expect.any(Number));
    expect(store.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
  });

  it('caps the history range and buckets it in storage', async () => {
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([]);
    const to = 100 * 24 * 60 * 60_000;
    const range = 31 * 24 * 60 * 60_000;
    await service.getFootprintHistory('c1', 0, to);
    expect(storage.getKvCacheFootprintSnapshots).toHaveBeenLastCalledWith({
      connectionId: 'c1',
      from: to - range,
      to,
      bucketMs: Math.ceil(range / 1000),
      limit: 1001,
    });
  });

  it('returns the bucketed rows as stored', async () => {
    const snapshots = [{ timestamp: 1 }, { timestamp: 2 }];
    storage.getKvCacheFootprintSnapshots.mockResolvedValue(snapshots);
    expect(await service.getFootprintHistory('c1', 0, 60_000)).toEqual(snapshots);
  });
});
