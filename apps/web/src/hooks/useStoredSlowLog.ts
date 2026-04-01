import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';

interface UseStoredSlowLogOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  enabled?: boolean;
}

export function useStoredSlowLog({
  connectionId,
  startTime,
  endTime,
  enabled = true,
}: UseStoredSlowLogOptions) {
  return useQuery({
    queryKey: ['stored-slowlog', connectionId, startTime, endTime],
    queryFn: () => metricsApi.getStoredSlowLog({ startTime, endTime, limit: 100 }),
    enabled: enabled && startTime !== undefined && endTime !== undefined,
  });
}
