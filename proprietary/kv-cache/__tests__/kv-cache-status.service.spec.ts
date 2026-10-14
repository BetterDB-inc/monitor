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
  const footprint = { getSampleKey: jest.fn().mockReturnValue('m@1@0@abc…@bfloat16') } as any;
  const service = new KvCacheStatusService(storage, footprint, registry);

  it('never exposes the auth header', () => {
    const pub = toPublicEngine(engine as any);
    expect(pub).not.toHaveProperty('scrapeAuthHeader');
    expect(pub).not.toHaveProperty('scrapeAuthEncrypted');
    expect(pub.hasScrapeAuth).toBe(true);
  });

  it('builds status from the latest snapshot', async () => {
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([{ detected: true }]);
    const status = await service.getStatus('c1');
    expect(storage.getKvCacheFootprintSnapshots).toHaveBeenCalledWith({ connectionId: 'c1', limit: 1 });
    expect(registry.list).toHaveBeenCalledWith('c1');
    expect(status).toEqual({ hasLmcache: true, latest: { detected: true }, sampleKey: 'm@1@0@abc…@bfloat16', engines: [toPublicEngine(engine as any)] });
  });

  it('reports not detected without a snapshot', async () => {
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([]);
    expect((await service.getStatus('c1')).hasLmcache).toBe(false);
  });

  it('caps the history range', async () => {
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([]);
    const to = 100 * 24 * 60 * 60_000;
    await service.getFootprintHistory('c1', 0, to);
    expect(storage.getKvCacheFootprintSnapshots).toHaveBeenLastCalledWith({ connectionId: 'c1', from: to - 31 * 24 * 60 * 60_000, to, limit: 10_000 });
  });
});
