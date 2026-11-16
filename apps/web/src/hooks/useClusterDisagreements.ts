import { Feature } from '@betterdb/shared';
import { metricsApi } from '../api/metrics';
import type { TopologyDisagreementSummary } from '../types/anomaly';
import { useLicense } from './useLicense';
import { usePolling } from './usePolling';

const POLL_INTERVAL_MS = 5000;

export function useClusterDisagreements(connectionId: string | undefined, enabled: boolean) {
  const { hasFeature } = useLicense();
  const licensed = hasFeature(Feature.ANOMALY_DETECTION);
  const { data, error } = usePolling<TopologyDisagreementSummary>({
    fetcher: (signal) => metricsApi.getTopologyDisagreements(signal),
    interval: POLL_INTERVAL_MS,
    enabled: enabled && licensed && !!connectionId,
    queryKey: ['cluster-disagreements', connectionId],
  });

  return { licensed, summary: data ?? undefined, error };
}
