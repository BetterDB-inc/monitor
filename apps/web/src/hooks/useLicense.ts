import { createContext, useContext, useState, useEffect } from 'react';
import { licenseApi, type LicenseStatus } from '../api/license';
import { Feature } from '@betterdb/shared';

export const LicenseContext = createContext<LicenseStatus | null>(null);

export function useLicense() {
  const license = useContext(LicenseContext);

  return {
    license,
    tier: license?.tier || 'community',
    hasFeature: (feature: Feature) => license?.features?.includes(feature) ?? false,
    retentionLimits: license?.retentionLimits,
  };
}

export function useLicenseStatus() {
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    licenseApi
      .getStatus()
      .then(setLicense)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  return { license, loading, error };
}
