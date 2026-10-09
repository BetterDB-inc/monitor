import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { kvCacheApi } from './kv-cache';

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

  it('getSamples builds the query and omits unset filters', async () => {
    await kvCacheApi.getSamples({ from: 1, to: 2, engineId: 'e' });
    expect(fetchMock.mock.calls[0][0]).toContain('/kv-cache/engines/samples?from=1&to=2&engineId=e');
    expect(fetchMock.mock.calls[0][0]).not.toContain('model=');
  });
});
