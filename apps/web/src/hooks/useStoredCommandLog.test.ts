import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/metrics', () => ({
  metricsApi: { getStoredCommandLog: vi.fn() },
}));

import { metricsApi } from '../api/metrics';
import { useStoredCommandLog } from './useStoredCommandLog';

const mockGet = vi.mocked(metricsApi.getStoredCommandLog);

beforeEach(() => vi.clearAllMocks());

describe('useStoredCommandLog', () => {
  it('does not fetch when disabled', () => {
    renderHookWithQuery(() =>
      useStoredCommandLog({ connectionId: 'test', activeTab: 'slow', page: 0, enabled: false }),
    );
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches entries with pagination', async () => {
    const entries = Array.from({ length: 101 }, (_, i) => ({ id: i }));
    mockGet.mockResolvedValue(entries);

    const { result } = renderHookWithQuery(() =>
      useStoredCommandLog({
        connectionId: 'test',
        startTime: 1000,
        endTime: 2000,
        activeTab: 'slow',
        page: 0,
      }),
    );

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data!.entries).toHaveLength(100);
    expect(result.current.data!.hasMore).toBe(true);
  });

  it('sets hasMore to false when fewer entries returned', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    mockGet.mockResolvedValue(entries);

    const { result } = renderHookWithQuery(() =>
      useStoredCommandLog({
        connectionId: 'test',
        startTime: 1000,
        endTime: 2000,
        activeTab: 'slow',
        page: 0,
      }),
    );

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data!.entries).toHaveLength(50);
    expect(result.current.data!.hasMore).toBe(false);
  });
});
