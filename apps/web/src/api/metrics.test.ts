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
