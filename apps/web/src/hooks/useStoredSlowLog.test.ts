import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/metrics', () => ({
  metricsApi: { getStoredSlowLog: vi.fn() },
}));

import { metricsApi } from '../api/metrics';
import { useStoredSlowLog } from './useStoredSlowLog';

const mockGet = vi.mocked(metricsApi.getStoredSlowLog);

beforeEach(() => vi.clearAllMocks());

describe('useStoredSlowLog', () => {
  it('does not fetch when time range is not set', () => {
    renderHookWithQuery(() => useStoredSlowLog({ connectionId: 'test' }));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches slow log when time range is set', async () => {
    const mockData = [{ id: 1, command: 'GET foo', duration: 500 }];
    mockGet.mockResolvedValue(mockData);

    const { result } = renderHookWithQuery(() =>
      useStoredSlowLog({ connectionId: 'test', startTime: 1000, endTime: 2000 }),
    );

    await waitFor(() => expect(result.current.data).toEqual(mockData));
    expect(mockGet).toHaveBeenCalledWith({ startTime: 1000, endTime: 2000, limit: 100 });
  });
});
