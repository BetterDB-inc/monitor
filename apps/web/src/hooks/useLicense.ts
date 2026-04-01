import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { licenseApi, type LicenseStatus } from '../api/license';
import { Feature } from '@betterdb/shared';

export const LicenseContext = createContext<LicenseStatus | null>(null);

export function useLicense() {
  const license = useContext(LicenseContext);

  return {
    license,
    tier: license?.tier || 'community',
    hasFeature: (feature: Feature) => license?.features?.includes(feature) ?? false,
  };
}

export function useLicenseStatus() {
  const { data, isLoading, error } = useQuery<LicenseStatus, Error>({
    queryKey: ['license-status'],
    queryFn: () => licenseApi.getStatus(),
  });

  return {
    license: data ?? null,
    loading: isLoading,
    error: error ?? null,
  };
}
