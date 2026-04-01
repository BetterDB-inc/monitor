import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';

interface UseStoredLatencyOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  enabled?: boolean;
}

export function useStoredLatencySnapshots({
  connectionId,
  startTime,
  endTime,
  enabled = true,
}: UseStoredLatencyOptions) {
  return useQuery({
    queryKey: ['stored-latency-snapshots', connectionId, startTime, endTime],
    queryFn: () => metricsApi.getStoredLatencySnapshots({ startTime, endTime, limit: 500 }),
    enabled: enabled && startTime !== undefined && endTime !== undefined,
  });
}

export function useStoredLatencyHistograms({
  connectionId,
  startTime,
  endTime,
  enabled = true,
}: UseStoredLatencyOptions) {
  return useQuery({
    queryKey: ['stored-latency-histograms', connectionId, startTime, endTime],
    queryFn: async () => {
      const histograms = await metricsApi.getStoredLatencyHistograms({ startTime, endTime, limit: 1 });
      return histograms.length > 0 ? histograms[0].data : null;
    },
    enabled: enabled && startTime !== undefined && endTime !== undefined,
  });
}
