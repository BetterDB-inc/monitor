import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchApi } from './client';
import { metricsApi } from './metrics';

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, fetchApi: vi.fn().mockResolvedValue([]) };
});

describe('metricsApi hot shards', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockClear();
  });

  it('reads the open hot shards of the current connection', async () => {
    await metricsApi.getHotShards();

    expect(fetchApi).toHaveBeenCalledWith('/anomaly/hot-shards');
  });
});

describe('metricsApi topology disagreements', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockClear();
  });

  it('names the connection it asks about instead of relying on the current one', async () => {
    const { signal } = new AbortController();

    await metricsApi.getTopologyDisagreements('conn-7', signal);

    expect(fetchApi).toHaveBeenCalledWith('/anomaly/topology-disagreements', {
      signal,
      headers: { 'x-connection-id': 'conn-7' },
    });
  });

  it('names the connection whose nodes a full check asks', async () => {
    await metricsApi.startTopologyFullCheck('conn-7');

    expect(fetchApi).toHaveBeenCalledWith('/anomaly/topology-disagreements/full-check', {
      method: 'POST',
      headers: { 'x-connection-id': 'conn-7' },
    });
  });
});
