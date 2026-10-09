import { fetchMetricsText, ScrapeError } from '../metrics-fetch';
import { KvCacheScrapeService } from '../kv-cache-scrape.service';

jest.mock('../metrics-fetch', () => ({
  ...jest.requireActual('../metrics-fetch'),
  fetchMetricsText: jest.fn(),
}));

const fetchMock = fetchMetricsText as jest.Mock;

const engine = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  connectionId: 'c1',
  enabled: true,
  source: 'scrape',
  scrapeUrl: 'http://engine-1:9090/metrics',
  ...over,
});

const body = 'lmcache:num_hit_tokens_total{model_name="m",worker_id="0",role="worker"} 42\n';

function setup(engines: unknown[], licensed = true) {
  const registry = {
    list: jest.fn().mockReturnValue(engines),
    get: jest.fn((id: string) => (engines as { id: string }[]).find((e) => e.id === id) ?? null),
    recordResult: jest.fn(),
  };
  const samples = { observe: jest.fn() };
  const engineService = { authHeaderFor: jest.fn().mockReturnValue(null) };
  const license = { hasFeature: jest.fn().mockReturnValue(licensed) };
  const service = new KvCacheScrapeService(registry as any, samples as any, engineService as any, license as any);
  return { registry, samples, engineService, license, service };
}

describe('KvCacheScrapeService', () => {
  beforeEach(() => fetchMock.mockReset());

  it('does not fetch when unlicensed', async () => {
    const { service } = setup([engine()], false);
    await service.tick(1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips disabled and OTLP engines', async () => {
    const { service } = setup([engine({ id: 'off', enabled: false }), engine({ id: 'otlp', source: 'otlp' })]);
    await service.tick(1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('observes cumulative samples and records success', async () => {
    fetchMock.mockResolvedValue(body);
    const { service, samples, registry } = setup([engine()]);
    await service.tick(5000);
    expect(samples.observe).toHaveBeenCalledWith(
      {
        engineId: 'e1',
        connectionId: 'c1',
        modelName: 'm',
        series: '0|worker',
        metric: 'num_hit_tokens',
        value: 42,
        cumulative: true,
      },
      5000,
    );
    expect(registry.recordResult).toHaveBeenCalledWith('e1', { lastSeenAt: 5000, lastError: null });
  });

  it('records a scrape error and still scrapes the other engines', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('engine-1')) throw new ScrapeError('HTTP 401');
      return body;
    });
    const { service, registry, samples } = setup([engine(), engine({ id: 'e2', scrapeUrl: 'http://engine-2:9090/metrics' })]);
    await service.tick(1000);
    expect(registry.recordResult).toHaveBeenCalledWith('e1', { lastError: 'HTTP 401' });
    expect(samples.observe).toHaveBeenCalledWith(expect.objectContaining({ engineId: 'e2' }), 1000);
  });

  it('discards a response when the engine was removed, disabled or repointed during the fetch', async () => {
    fetchMock.mockResolvedValue(body);
    for (const current of [null, engine({ enabled: false }), engine({ scrapeUrl: 'http://engine-9:9090/metrics' })]) {
      const { service, registry, samples } = setup([engine()]);
      registry.get.mockReturnValue(current);
      await service.tick(1000);
      expect(samples.observe).not.toHaveBeenCalled();
      expect(registry.recordResult).not.toHaveBeenCalled();
    }
  });

  it('records a generic error for unexpected failures', async () => {
    fetchMock.mockRejectedValue(new Error('secret-host leaked'));
    const { service, registry } = setup([engine()]);
    await service.tick(1000);
    expect(registry.recordResult).toHaveBeenCalledWith('e1', { lastError: 'scrape failed' });
  });

  it('flags a response without lmcache metrics', async () => {
    fetchMock.mockResolvedValue('other_metric 1\n');
    const { service, registry } = setup([engine()]);
    await service.tick(1000);
    expect(registry.recordResult).toHaveBeenCalledWith('e1', { lastSeenAt: 1000, lastError: 'no lmcache metrics found' });
  });

  it('fetches once for overlapping ticks', async () => {
    let release: (text: string) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<string>((resolve) => (release = resolve)));
    const { service } = setup([engine()]);
    const first = service.tick(1000);
    const second = service.tick(2000);
    release(body);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('scrapes again on a later tick after the first completes', async () => {
    fetchMock.mockResolvedValue(body);
    const { service } = setup([engine()]);
    await service.tick(1000);
    await service.tick(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('starts scraping once the licence becomes active', async () => {
    fetchMock.mockResolvedValue(body);
    const { service, license } = setup([engine()], false);
    await service.tick(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    license.hasFeature.mockReturnValue(true);
    await service.tick(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('interval', () => {
    const original = process.env.KV_CACHE_SCRAPE_INTERVAL_MS;
    afterEach(() => {
      if (original === undefined) delete process.env.KV_CACHE_SCRAPE_INTERVAL_MS;
      else process.env.KV_CACHE_SCRAPE_INTERVAL_MS = original;
      jest.restoreAllMocks();
    });

    it.each([
      ['abc', 30000],
      ['0', 30000],
      ['-5', 30000],
      ['', 30000],
      ['5000', 5000],
    ])('uses the right interval for %p', (value, expected) => {
      process.env.KV_CACHE_SCRAPE_INTERVAL_MS = value;
      const spy = jest.spyOn(global, 'setInterval');
      const { service } = setup([]);
      service.onModuleInit();
      service.onModuleDestroy();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), expected);
    });
  });
});
