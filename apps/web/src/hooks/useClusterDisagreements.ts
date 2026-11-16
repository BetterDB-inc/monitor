import { Feature } from '@betterdb/shared';
import { metricsApi } from '../api/metrics';
import type { TopologyDisagreementSummary } from '../types/anomaly';
import { useLicense, useLicenseStatus } from './useLicense';
import { usePolling } from './usePolling';

const POLL_INTERVAL_MS = 5000;

export function useClusterDisagreements(connectionId: string | undefined, enabled: boolean) {
  const { license, hasFeature } = useLicense();
  const { loading } = useLicenseStatus();
  const licensed = hasFeature(Feature.ANOMALY_DETECTION);
  const { data, error } = usePolling<TopologyDisagreementSummary>({
    fetcher: (signal) => metricsApi.getTopologyDisagreements(connectionId as string, signal),
    interval: POLL_INTERVAL_MS,
    enabled: enabled && licensed && !!connectionId,
    queryKey: ['cluster-disagreements', connectionId],
  });

  return {
    licensed,
    licenseLoading: license === null && loading,
    summary: data ?? undefined,
    error,
  };
}
