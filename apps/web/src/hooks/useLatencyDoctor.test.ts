import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/metrics', () => ({
  metricsApi: {
    getLatencyDoctor: vi.fn(),
  },
}));

import { metricsApi } from '../api/metrics';
import { useLatencyDoctor } from './useLatencyDoctor';

const mockGetDoctor = vi.mocked(metricsApi.getLatencyDoctor);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLatencyDoctor', () => {
  it('fetches doctor report', async () => {
    const report = { summary: 'All good', issues: [] };
    mockGetDoctor.mockResolvedValue({ report });

    const { result } = renderHookWithQuery(() => useLatencyDoctor('test-conn'));

    await waitFor(() => {
      expect(result.current.data).toEqual(report);
    });
  });

  it('returns error on failure', async () => {
    mockGetDoctor.mockRejectedValue(new Error('Server error'));

    const { result } = renderHookWithQuery(() => useLatencyDoctor('test-conn'));

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });
  });
});
