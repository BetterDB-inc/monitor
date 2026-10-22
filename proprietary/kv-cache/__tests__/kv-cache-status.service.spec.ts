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
