import { useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Feature } from '@betterdb/shared';
import { metricsApi } from '../api/metrics';
import type { TopologyDisagreementReport, TopologyFullCheck } from '../types/anomaly';
import { useLicense, useLicenseStatus } from './useLicense';
import { usePolling } from './usePolling';

const POLL_INTERVAL_MS = 5000;
const FULL_CHECK_POLL_INTERVAL_MS = 2000;

export function disagreementsPollInterval(report: TopologyDisagreementReport | undefined): number {
  return report?.fullCheck?.state === 'running' ? FULL_CHECK_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
}

export function useClusterDisagreements(connectionId: string | undefined, enabled: boolean) {
  const { license, hasFeature } = useLicense();
  const { loading } = useLicenseStatus();
  const licensed = hasFeature(Feature.ANOMALY_DETECTION);
  const { data, error, refresh } = usePolling<TopologyDisagreementReport>({
    fetcher: (signal) => metricsApi.getTopologyDisagreements(connectionId as string, signal),
    interval: disagreementsPollInterval,
    enabled: enabled && licensed && !!connectionId,
    queryKey: ['cluster-disagreements', connectionId],
  });
  const {
    mutate,
    reset,
    isPending,
    error: askError,
  } = useMutation<TopologyFullCheck, Error, string>({
    mutationFn: (id) => metricsApi.startTopologyFullCheck(id),
    onSuccess: () => refresh(),
  });

  useEffect(() => reset, [connectionId, reset]);

  return {
    licensed,
    licenseLoading: license === null && loading,
    summary: data ?? undefined,
    error,
    askEveryNode: () => {
      if (connectionId) mutate(connectionId);
    },
    asking: isPending,
    askError,
  };
}
