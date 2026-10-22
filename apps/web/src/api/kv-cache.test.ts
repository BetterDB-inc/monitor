import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { kvCacheApi, kvCacheKeys } from './kv-cache';

describe('kvCacheApi', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [{ scrapeAuthHeader: null }],
    [{ scrapeAuthHeader: '' }],
    [{ name: 'a', scrapeUrl: 'http://x:8000/metrics', scrapeAuthHeader: 'Bearer t' }],
  ])('updateEngine passes the body through unchanged', async (body) => {
    await kvCacheApi.updateEngine('e/1', body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/kv-cache/engines/e%2F1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it('updateSettings targets the connection it was given', async () => {
    await kvCacheApi.updateSettings({ hitRateAlertEnabled: false }, 'c9');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/kv-cache/settings');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('x-connection-id')).toBe('c9');
  });

  it('getSamples builds the range query', async () => {
    await kvCacheApi.getSamples({ from: 1, to: 2 });
    expect(fetchMock.mock.calls[0][0]).toContain('/kv-cache/engines/samples?from=1&to=2');
  });
});

describe('kvCacheKeys', () => {
  it('keeps every samples key under the samples prefix used for invalidation', () => {
    const prefix = kvCacheKeys.samplesAll('c1');
    expect(kvCacheKeys.samples('c1', { from: 1 }).slice(0, prefix.length)).toEqual(prefix);
  });

  it('keeps the live history key apart from the default-range history key', () => {
    expect(kvCacheKeys.liveHistory('c1')).not.toEqual(kvCacheKeys.history('c1', 0, 0));
  });

  it('keeps the live history key under the history prefix so rescans refresh it', () => {
    const prefix = kvCacheKeys.historyAll('c1');
    expect(kvCacheKeys.liveHistory('c1').slice(0, prefix.length)).toEqual(prefix);
  });
});
