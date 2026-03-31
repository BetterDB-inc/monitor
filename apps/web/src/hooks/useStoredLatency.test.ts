import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/metrics', () => ({
  metricsApi: {
    getStoredLatencySnapshots: vi.fn(),
    getStoredLatencyHistograms: vi.fn(),
  },
}));

import { metricsApi } from '../api/metrics';
import { useStoredLatencySnapshots, useStoredLatencyHistograms } from './useStoredLatency';

const mockGetSnapshots = vi.mocked(metricsApi.getStoredLatencySnapshots);
const mockGetHistograms = vi.mocked(metricsApi.getStoredLatencyHistograms);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useStoredLatencySnapshots', () => {
  it('does not fetch when time range is not set', () => {
    renderHookWithQuery(() => useStoredLatencySnapshots({ connectionId: 'test' }));
    expect(mockGetSnapshots).not.toHaveBeenCalled();
  });

  it('fetches snapshots when time range is set', async () => {
    const mockData = [{ id: '1', eventName: 'get', maxLatency: 5 }];
    mockGetSnapshots.mockResolvedValue(mockData);

    const { result } = renderHookWithQuery(() =>
      useStoredLatencySnapshots({ connectionId: 'test', startTime: 1000, endTime: 2000 }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(mockData);
    });
  });
});

describe('useStoredLatencyHistograms', () => {
  it('does not fetch when disabled', () => {
    renderHookWithQuery(() =>
      useStoredLatencyHistograms({ connectionId: 'test', startTime: 1000, endTime: 2000, enabled: false }),
    );
    expect(mockGetHistograms).not.toHaveBeenCalled();
  });

  it('returns histogram data from first result', async () => {
    const histData = { get: { avg: 1, min: 0, max: 5, p50: 1, p99: 4 } };
    mockGetHistograms.mockResolvedValue([{ data: histData }]);

    const { result } = renderHookWithQuery(() =>
      useStoredLatencyHistograms({ connectionId: 'test', startTime: 1000, endTime: 2000 }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(histData);
    });
  });

  it('returns null when no histograms found', async () => {
    mockGetHistograms.mockResolvedValue([]);

    const { result } = renderHookWithQuery(() =>
      useStoredLatencyHistograms({ connectionId: 'test', startTime: 1000, endTime: 2000 }),
    );

    await waitFor(() => {
      expect(result.current.isFetched).toBe(true);
    });

    expect(result.current.data).toBeNull();
  });
});
