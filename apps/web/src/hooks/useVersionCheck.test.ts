import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor, act } from '../test/test-utils';

vi.mock('../api/version', () => ({
  versionApi: {
    getVersion: vi.fn(),
  },
}));

import { versionApi } from '../api/version';
import { useVersionCheckState } from './useVersionCheck';

const mockGetVersion = vi.mocked(versionApi.getVersion);

const storage = new Map<string, string>();
const mockLocalStorage = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  removeItem: vi.fn((key: string) => storage.delete(key)),
};

beforeEach(() => {
  vi.clearAllMocks();
  storage.clear();
  vi.stubGlobal('localStorage', mockLocalStorage);
});

describe('useVersionCheckState', () => {
  it('starts in loading state', () => {
    mockGetVersion.mockReturnValue(new Promise(() => {}));
    const { result } = renderHookWithQuery(() => useVersionCheckState());
    expect(result.current.loading).toBe(true);
  });

  it('returns version info on success', async () => {
    mockGetVersion.mockResolvedValue({
      current: '1.0.0',
      latest: '1.1.0',
      updateAvailable: true,
      releaseUrl: 'https://example.com/release',
      checkedAt: Date.now(),
    });

    const { result } = renderHookWithQuery(() => useVersionCheckState());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.current).toBe('1.0.0');
    expect(result.current.latest).toBe('1.1.0');
    expect(result.current.updateAvailable).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('handles dismiss and persists to localStorage', async () => {
    mockGetVersion.mockResolvedValue({
      current: '1.0.0',
      latest: '1.1.0',
      updateAvailable: true,
      releaseUrl: null,
      checkedAt: Date.now(),
    });

    const { result } = renderHookWithQuery(() => useVersionCheckState());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.dismissed).toBe(false);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.dismissed).toBe(true);
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('betterdb_update_dismissed_version', '1.1.0');
  });

  it('is not dismissed when a newer version arrives', async () => {
    storage.set('betterdb_update_dismissed_version', '1.0.0');

    mockGetVersion.mockResolvedValue({
      current: '1.0.0',
      latest: '1.1.0',
      updateAvailable: true,
      releaseUrl: null,
      checkedAt: Date.now(),
    });

    const { result } = renderHookWithQuery(() => useVersionCheckState());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.dismissed).toBe(false);
  });

  it('returns error on failure', async () => {
    mockGetVersion.mockRejectedValue(new Error('Fetch failed'));

    const { result } = renderHookWithQuery(() => useVersionCheckState());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
