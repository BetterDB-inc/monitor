import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/metrics', () => ({
  metricsApi: {
    getLatencyHistory: vi.fn(),
  },
}));

import { metricsApi } from '../api/metrics';
import { useLatencyHistory } from './useLatencyHistory';

const mockGetHistory = vi.mocked(metricsApi.getLatencyHistory);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLatencyHistory', () => {
  it('does not fetch when no event selected', () => {
    renderHookWithQuery(() => useLatencyHistory(null, 'test-conn'));
    expect(mockGetHistory).not.toHaveBeenCalled();
  });

  it('fetches history for selected event', async () => {
    const mockData = [{ timestamp: 1000, latency: 5 }];
    mockGetHistory.mockResolvedValue(mockData);

    const { result } = renderHookWithQuery(() => useLatencyHistory('command.get', 'test-conn'));

    await waitFor(() => {
      expect(result.current.data).toEqual(mockData);
    });

    expect(mockGetHistory).toHaveBeenCalledWith('command.get');
  });
});
