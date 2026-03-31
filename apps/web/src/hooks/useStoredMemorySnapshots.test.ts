import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/metrics', () => ({
  metricsApi: {
    getStoredMemorySnapshots: vi.fn(),
  },
}));

import { metricsApi } from '../api/metrics';
import { useStoredMemorySnapshots } from './useStoredMemorySnapshots';

const mockGetSnapshots = vi.mocked(metricsApi.getStoredMemorySnapshots);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useStoredMemorySnapshots', () => {
  it('does not fetch when time filter is not set', () => {
    const { result } = renderHookWithQuery(() =>
      useStoredMemorySnapshots({ connectionId: 'test' }),
    );
    expect(mockGetSnapshots).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('does not fetch when enabled is false', () => {
    const { result } = renderHookWithQuery(() =>
      useStoredMemorySnapshots({
        connectionId: 'test',
        startTime: 1000,
        endTime: 2000,
        enabled: false,
      }),
    );
    expect(mockGetSnapshots).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('fetches snapshots when time filter is set', async () => {
    const mockData = [
      { id: '1', timestamp: 1000, opsPerSec: 100, usedMemory: 500 },
      { id: '2', timestamp: 2000, opsPerSec: 200, usedMemory: 600 },
    ];
    mockGetSnapshots.mockResolvedValue(mockData);

    const { result } = renderHookWithQuery(() =>
      useStoredMemorySnapshots({
        connectionId: 'test',
        startTime: 1000,
        endTime: 2000,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(mockData);
    });

    expect(mockGetSnapshots).toHaveBeenCalledWith({
      startTime: 1000,
      endTime: 2000,
      limit: 500,
    });
  });
});
