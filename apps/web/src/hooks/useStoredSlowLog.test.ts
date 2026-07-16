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

  it('fetches without a time range when sorting by magnitude', async () => {
    const mockData = [{ id: 2, command: 'SORT big', duration: 500000 }];
    mockGet.mockResolvedValue(mockData);

    const { result } = renderHookWithQuery(() =>
      useStoredSlowLog({ connectionId: 'test', sortBy: 'magnitude' }),
    );

    await waitFor(() => expect(result.current.data).toEqual(mockData));
    expect(mockGet).toHaveBeenCalledWith({
      startTime: undefined,
      endTime: undefined,
      limit: 100,
      sortBy: 'magnitude',
    });
  });

  it('does not send sortBy for the default recent order', async () => {
    mockGet.mockResolvedValue([]);

    renderHookWithQuery(() =>
      useStoredSlowLog({ connectionId: 'test', startTime: 1000, endTime: 2000, sortBy: 'recent' }),
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(mockGet).toHaveBeenCalledWith(
      expect.not.objectContaining({ sortBy: expect.anything() }),
    );
  });
});
