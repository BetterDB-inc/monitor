import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';
import type { LogSortBy } from '../types/metrics';

interface UseStoredSlowLogOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  sortBy?: LogSortBy;
  enabled?: boolean;
}

export function useStoredSlowLog({
  connectionId,
  startTime,
  endTime,
  sortBy,
  enabled = true,
}: UseStoredSlowLogOptions) {
  const hasTimeRange = startTime !== undefined && endTime !== undefined;
  return useQuery({
    queryKey: ['stored-slowlog', connectionId, startTime, endTime, sortBy ?? 'recent'],
    queryFn: () =>
      metricsApi.getStoredSlowLog({
        startTime,
        endTime,
        limit: 100,
        ...(sortBy === 'magnitude' ? { sortBy } : {}),
      }),
    // Magnitude sort queries the full stored history, so it works without a
    // time range; recency-sorted stored queries still require one (the live
    // poller covers the unfiltered case).
    enabled: enabled && (hasTimeRange || sortBy === 'magnitude'),
  });
}
