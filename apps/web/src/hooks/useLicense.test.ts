import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/license', () => ({
  licenseApi: {
    getStatus: vi.fn(),
  },
}));

import { licenseApi } from '../api/license';
import { useLicenseStatus } from './useLicense';

const mockGetStatus = vi.mocked(licenseApi.getStatus);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLicenseStatus', () => {
  it('starts in loading state', () => {
    mockGetStatus.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHookWithQuery(() => useLicenseStatus());
    expect(result.current.loading).toBe(true);
    expect(result.current.license).toBeNull();
  });

  it('returns license data on success', async () => {
    const mockLicense = { tier: 'pro', features: ['anomaly-detection'], valid: true };
    mockGetStatus.mockResolvedValue(mockLicense);

    const { result } = renderHookWithQuery(() => useLicenseStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.license).toEqual(mockLicense);
    expect(result.current.error).toBeNull();
  });

  it('exposes offline-license fields from the status endpoint', async () => {
    const mockLicense = {
      tier: 'enterprise',
      features: [],
      valid: true,
      source: 'offline-token',
      mode: 'offline',
      instanceLimit: 10,
      offlineExpiresAt: '2027-01-01T00:00:00.000Z',
      clockRollbackSuspected: false,
    };
    mockGetStatus.mockResolvedValue(mockLicense);

    const { result } = renderHookWithQuery(() => useLicenseStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.license?.source).toBe('offline-token');
    expect(result.current.license?.instanceLimit).toBe(10);
    expect(result.current.license?.offlineExpiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('returns error on failure', async () => {
    mockGetStatus.mockRejectedValue(new Error('Network error'));

    const { result } = renderHookWithQuery(() => useLicenseStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.license).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
