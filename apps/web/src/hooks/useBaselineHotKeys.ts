import { useQuery } from '@tanstack/react-query';
import { keyAnalyticsApi } from '../api/keyAnalytics';

interface UseBaselineHotKeysOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  enabled?: boolean;
}

export function useBaselineHotKeys({
  connectionId,
  startTime,
  endTime,
  enabled = true,
}: UseBaselineHotKeysOptions) {
  return useQuery({
    queryKey: ['hot-keys-baseline', connectionId, startTime, endTime],
    queryFn: async () => {
      const entries = await keyAnalyticsApi.getHotKeys({
        limit: 50,
        startTime,
        endTime,
        oldest: true,
      });
      return entries.length > 0 ? entries : null;
    },
    enabled: enabled && startTime !== undefined && endTime !== undefined,
  });
}
