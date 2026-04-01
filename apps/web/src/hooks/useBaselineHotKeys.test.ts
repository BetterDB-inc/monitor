import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';
import type { HotKeyEntry } from '@betterdb/shared';

vi.mock('../api/keyAnalytics', () => ({
  keyAnalyticsApi: {
    getHotKeys: vi.fn(),
  },
}));

import { keyAnalyticsApi } from '../api/keyAnalytics';
import { useBaselineHotKeys } from './useBaselineHotKeys';

const mockGetHotKeys = vi.mocked(keyAnalyticsApi.getHotKeys);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBaselineHotKeys', () => {
  it('does not fetch when time range is not set', () => {
    renderHookWithQuery(() =>
      useBaselineHotKeys({ connectionId: 'test' }),
    );
    expect(mockGetHotKeys).not.toHaveBeenCalled();
  });

  it('does not fetch when disabled', () => {
    renderHookWithQuery(() =>
      useBaselineHotKeys({ connectionId: 'test', startTime: 1000, endTime: 2000, enabled: false }),
    );
    expect(mockGetHotKeys).not.toHaveBeenCalled();
  });

  it('fetches baseline hot keys with oldest flag', async () => {
    const mockEntries: HotKeyEntry[] = [
      {
        id: 'hk-1',
        keyName: 'foo',
        connectionId: 'test',
        capturedAt: 1000,
        signalType: 'lfu',
        rank: 1,
      },
    ];
    mockGetHotKeys.mockResolvedValue(mockEntries);

    const { result } = renderHookWithQuery(() =>
      useBaselineHotKeys({ connectionId: 'test', startTime: 1000, endTime: 2000 }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(mockEntries);
    });

    expect(mockGetHotKeys).toHaveBeenCalledWith({
      limit: 50,
      startTime: 1000,
      endTime: 2000,
      oldest: true,
    });
  });

  it('returns null when no entries found', async () => {
    mockGetHotKeys.mockResolvedValue([]);

    const { result } = renderHookWithQuery(() =>
      useBaselineHotKeys({ connectionId: 'test', startTime: 1000, endTime: 2000 }),
    );

    await waitFor(() => {
      expect(result.current.isFetched).toBe(true);
    });

    expect(result.current.data).toBeNull();
  });
});
