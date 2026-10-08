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
  const registry = { list: jest.fn().mockReturnValue(engines), recordResult: jest.fn() };
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
});
