import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { fetchMetricsText, ScrapeError } from '../metrics-fetch';
import { KvCacheEnginesService } from '../kv-cache-engines.service';

jest.mock('../metrics-fetch', () => ({ ...jest.requireActual('../metrics-fetch'), fetchMetricsText: jest.fn() }));

const LMCACHE_BODY = 'lmcache:num_hit_tokens_total{model_name="m",worker_id="0",role="kv_both",served_model_name="m"} 5\n';
const fetchMock = fetchMetricsText as jest.Mock;

function setup(encrypted = true) {
  const store = new Map<string, any>();
  const registry = {
    list: jest.fn((connectionId?: string) => [...store.values()].filter((e) => !connectionId || e.connectionId === connectionId)),
    get: jest.fn((id: string) => store.get(id) ?? null),
    byOtlpId: jest.fn((otlp: string) => [...store.values()].find((e) => e.otlpEngineId === otlp) ?? null),
    save: jest.fn(async (e: any) => (store.set(e.id, e), e)),
    remove: jest.fn(async (id: string) => store.delete(id)),
  } as any;
  const encryption = encrypted ? { encrypt: (s: string) => 'enc:' + s, decrypt: (s: string) => s.slice(4) } : null;
  const connections = { getEncryptionService: jest.fn().mockReturnValue(encryption) } as any;
  const samples = { deleteEngine: jest.fn().mockResolvedValue(undefined), resetBaselines: jest.fn() } as any;
  return { service: new KvCacheEnginesService(registry, connections, samples), registry, store, connections, samples };
}

describe('KvCacheEnginesService', () => {
  beforeEach(() => fetchMock.mockReset().mockResolvedValue(LMCACHE_BODY));

  it('creates a scrape engine with an encrypted header', async () => {
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x/metrics', scrapeAuthHeader: 'Bearer t' });
    expect(fetchMock).toHaveBeenCalledWith('http://x/metrics', 'Bearer t');
    const stored = store.get(created.id);
    expect(stored).toMatchObject({ scrapeAuthHeader: 'enc:Bearer t', scrapeAuthEncrypted: true, lastError: null });
    expect(stored.lastSeenAt).toEqual(expect.any(Number));
    expect(created.hasScrapeAuth).toBe(true);
    expect(created).not.toHaveProperty('scrapeAuthHeader');
  });

  it('stores the header in plaintext without an encryption service', async () => {
    const { service, store } = setup(false);
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x', scrapeAuthHeader: 'Bearer t' });
    expect(store.get(created.id)).toMatchObject({ scrapeAuthHeader: 'Bearer t', scrapeAuthEncrypted: false });
  });

  it('flags a body without lmcache series', async () => {
    fetchMock.mockResolvedValue('other_metric 1\n');
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x' });
    expect(store.get(created.id)).toMatchObject({ lastError: 'no lmcache metrics found' });
    expect(store.get(created.id).lastSeenAt).toEqual(expect.any(Number));
  });

  it('rejects a failed test scrape and saves nothing', async () => {
    fetchMock.mockRejectedValue(new ScrapeError('HTTP 401'));
    const { service, registry } = setup();
    const error = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x' }).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('Test scrape failed: HTTP 401');
    expect(registry.save).not.toHaveBeenCalled();
  });

  it('requires a URL for scrape engines', async () => {
    const { service } = setup();
    await expect(service.create('c1', { name: 'n', source: 'scrape' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('generates and de-duplicates otlp engine ids', async () => {
    const { service, store } = setup();
    const generated = await service.create('c1', { name: 'n', source: 'otlp', scrapeUrl: 'http://ignored' });
    expect(generated.otlpEngineId).toMatch(/^lmc-[0-9a-f]{12}$/);
    expect(store.get(generated.id)).toMatchObject({ scrapeUrl: null, scrapeAuthHeader: null });
    expect(fetchMock).not.toHaveBeenCalled();
    await service.create('c1', { name: 'n2', source: 'otlp', otlpEngineId: 'mine' });
    await expect(service.create('c2', { name: 'n', source: 'otlp', otlpEngineId: 'mine' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create('c1', { name: 'n3', source: 'otlp', otlpEngineId: 'bad id!' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a duplicate engine name on the same connection', async () => {
    const { service, registry } = setup();
    const first = await service.create('c1', { name: 'vllm', source: 'otlp' });
    await expect(service.create('c1', { name: 'vllm', source: 'scrape', scrapeUrl: 'http://x' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create('c2', { name: 'vllm', source: 'otlp' })).resolves.toMatchObject({ name: 'vllm' });
    const second = await service.create('c1', { name: 'sglang', source: 'otlp' });
    await expect(service.update('c1', second.id, { name: 'vllm' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update('c1', first.id, { name: 'vllm' })).resolves.toMatchObject({ name: 'vllm' });
    expect(registry.save).toHaveBeenCalledTimes(4);
  });

  it('rejects a concurrent create with the same name while the first is still scraping', async () => {
    let finish: (body: string) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { service, store } = setup();
    const first = service.create('c1', { name: 'vllm', source: 'scrape', scrapeUrl: 'http://x' });
    await expect(service.create('c1', { name: 'vllm', source: 'otlp' })).rejects.toBeInstanceOf(ConflictException);
    finish(LMCACHE_BODY);
    await expect(first).resolves.toMatchObject({ name: 'vllm' });
    expect(store.size).toBe(1);
    await expect(service.create('c1', { name: 'vllm', source: 'otlp' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('releases a reserved name when the create fails', async () => {
    fetchMock.mockRejectedValueOnce(new ScrapeError('HTTP 401'));
    const { service } = setup();
    await expect(service.create('c1', { name: 'vllm', source: 'scrape', scrapeUrl: 'http://x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('c1', { name: 'vllm', source: 'otlp' })).resolves.toMatchObject({ name: 'vllm' });
  });

  it('resolves the stored auth header', () => {
    const base = { id: 'e', scrapeAuthHeader: 'Bearer t', scrapeAuthEncrypted: false } as any;
    expect(setup(false).service.authHeaderFor(base)).toBe('Bearer t');
    expect(setup(true).service.authHeaderFor({ ...base, scrapeAuthHeader: 'enc:Bearer t', scrapeAuthEncrypted: true })).toBe('Bearer t');
    expect(setup(true).service.authHeaderFor({ ...base, scrapeAuthHeader: null })).toBeNull();
    expect(setup(false).service.authHeaderFor({ ...base, scrapeAuthEncrypted: true })).toBeNull();
  });

  it('returns null when decryption throws', () => {
    const { service, connections } = setup();
    connections.getEncryptionService.mockReturnValue({ decrypt: () => { throw new Error('bad'); } });
    expect(service.authHeaderFor({ id: 'e', scrapeAuthHeader: 'x', scrapeAuthEncrypted: true } as any)).toBeNull();
  });

  it('updates only engines of the connection', async () => {
    const { service } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x', scrapeAuthHeader: 'Bearer t' });
    await expect(service.update('c2', created.id, { name: 'z' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update('c1', 'missing', { name: 'z' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clears, replaces and keeps the auth header', async () => {
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x', scrapeAuthHeader: 'Bearer t' });
    await service.update('c1', created.id, { name: 'renamed' });
    expect(store.get(created.id)).toMatchObject({ name: 'renamed', scrapeAuthHeader: 'enc:Bearer t' });
    const cleared = await service.update('c1', created.id, { scrapeAuthHeader: null });
    expect(cleared.hasScrapeAuth).toBe(false);
    expect(store.get(created.id)).toMatchObject({ scrapeAuthHeader: null, scrapeAuthEncrypted: false });
    await service.update('c1', created.id, { scrapeAuthHeader: 'Bearer n' });
    expect(store.get(created.id).scrapeAuthHeader).toBe('enc:Bearer n');
  });

  it('re-tests when the URL changes and not for a toggle', async () => {
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x', scrapeAuthHeader: 'Bearer t' });
    fetchMock.mockClear();
    await service.update('c1', created.id, { enabled: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(created.id).enabled).toBe(false);
    await service.update('c1', created.id, { scrapeUrl: 'http://x/y' });
    expect(fetchMock).toHaveBeenCalledWith('http://x/y', 'Bearer t');
    fetchMock.mockRejectedValue(new ScrapeError('timeout'));
    await expect(service.update('c1', created.id, { scrapeUrl: 'http://x/z' })).rejects.toThrow('Test scrape failed: timeout');
    expect(store.get(created.id).scrapeUrl).toBe('http://x/y');
  });

  it('removes engines of the connection', async () => {
    const { service, store, samples } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x' });
    await expect(service.remove('c2', created.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(samples.deleteEngine).not.toHaveBeenCalled();
    await service.remove('c1', created.id);
    expect(store.has(created.id)).toBe(false);
    expect(samples.deleteEngine).toHaveBeenCalledWith(created.id);
  });

  it('resets counter baselines when an engine is disabled', async () => {
    const { service, samples } = setup();
    const created = await service.create('c1', { name: 'n', source: 'otlp' });
    await service.update('c1', created.id, { name: 'renamed' });
    expect(samples.resetBaselines).not.toHaveBeenCalled();
    await service.update('c1', created.id, { enabled: false });
    expect(samples.resetBaselines).toHaveBeenCalledWith(created.id);
  });

  it('resets counter baselines when an engine is enabled again', async () => {
    const { service, samples } = setup();
    const created = await service.create('c1', { name: 'n', source: 'otlp', enabled: false });
    await service.update('c1', created.id, { enabled: true });
    expect(samples.resetBaselines).toHaveBeenCalledWith(created.id);
  });

  it('resets counter baselines when the scrape URL changes', async () => {
    const { service, samples } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x' });
    await service.update('c1', created.id, { scrapeUrl: 'http://x' });
    expect(samples.resetBaselines).not.toHaveBeenCalled();
    await service.update('c1', created.id, { scrapeUrl: 'http://y/metrics' });
    expect(samples.resetBaselines).toHaveBeenCalledWith(created.id);
  });

  it('sends the re-test without auth when the header is cleared with a URL change', async () => {
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x', scrapeAuthHeader: 'Bearer t' });
    fetchMock.mockClear();
    await service.update('c1', created.id, { scrapeUrl: 'http://other', scrapeAuthHeader: null });
    expect(fetchMock).toHaveBeenCalledWith('http://other', null);
    expect(store.get(created.id)).toMatchObject({ scrapeUrl: 'http://other', scrapeAuthHeader: null });
  });

  it('treats an empty header as a clear', async () => {
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x', scrapeAuthHeader: 'Bearer t' });
    fetchMock.mockClear();
    await service.update('c1', created.id, { scrapeUrl: 'http://x/other', scrapeAuthHeader: '' });
    expect(fetchMock).toHaveBeenCalledWith('http://x/other', null);
    expect(store.get(created.id)).toMatchObject({ scrapeAuthHeader: null, scrapeAuthEncrypted: false });
  });

  it('rejects an origin change that would carry the stored header over', async () => {
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x/metrics', scrapeAuthHeader: 'Bearer t' });
    fetchMock.mockClear();
    await expect(service.update('c1', created.id, { scrapeUrl: 'http://evil/metrics' })).rejects.toThrow(
      'Re-enter the scrape auth header when changing the scrape URL origin',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(created.id).scrapeUrl).toBe('http://x/metrics');
    await service.update('c1', created.id, { scrapeUrl: 'http://x/other' });
    expect(fetchMock).toHaveBeenCalledWith('http://x/other', 'Bearer t');
  });

  it('accepts an origin change with a new header', async () => {
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x', scrapeAuthHeader: 'Bearer t' });
    await service.update('c1', created.id, { scrapeUrl: 'http://y', scrapeAuthHeader: 'Bearer n' });
    expect(fetchMock).toHaveBeenLastCalledWith('http://y', 'Bearer n');
    expect(store.get(created.id)).toMatchObject({ scrapeUrl: 'http://y', scrapeAuthHeader: 'enc:Bearer n' });
  });

  it('fails when the engine is removed during the test scrape', async () => {
    const { service, store } = setup();
    const created = await service.create('c1', { name: 'n', source: 'scrape', scrapeUrl: 'http://x' });
    fetchMock.mockImplementation(async () => {
      store.delete(created.id);
      return LMCACHE_BODY;
    });
    await expect(service.update('c1', created.id, { scrapeUrl: 'http://x/2' })).rejects.toBeInstanceOf(NotFoundException);
    expect(store.has(created.id)).toBe(false);
  });
});
