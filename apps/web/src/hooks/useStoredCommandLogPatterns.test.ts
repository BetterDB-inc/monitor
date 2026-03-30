import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/metrics', () => ({
  metricsApi: { getStoredCommandLogPatternAnalysis: vi.fn() },
}));

import { metricsApi } from '../api/metrics';
import { useStoredCommandLogPatterns } from './useStoredCommandLogPatterns';

const mockGet = vi.mocked(metricsApi.getStoredCommandLogPatternAnalysis);

beforeEach(() => vi.clearAllMocks());

describe('useStoredCommandLogPatterns', () => {
  it('does not fetch when disabled', () => {
    renderHookWithQuery(() =>
      useStoredCommandLogPatterns({ connectionId: 'test', activeTab: 'slow', enabled: false }),
    );
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches patterns when enabled', async () => {
    const mockData = { patterns: [{ pattern: 'GET *', count: 10 }] };
    mockGet.mockResolvedValue(mockData);

    const { result } = renderHookWithQuery(() =>
      useStoredCommandLogPatterns({
        connectionId: 'test',
        startTime: 1000,
        endTime: 2000,
        activeTab: 'slow',
      }),
    );

    await waitFor(() => expect(result.current.data).toEqual(mockData));
    expect(mockGet).toHaveBeenCalledWith({ startTime: 1000, endTime: 2000, type: 'slow', limit: 500 });
  });
});
