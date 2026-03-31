import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';
import type { CommandLogType, SlowLogPatternAnalysis } from '../types/metrics';

interface UseStoredCommandLogPatternsOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  activeTab: CommandLogType;
  enabled?: boolean;
}

export function useStoredCommandLogPatterns({
  connectionId,
  startTime,
  endTime,
  activeTab,
  enabled = true,
}: UseStoredCommandLogPatternsOptions) {
  return useQuery<SlowLogPatternAnalysis>({
    queryKey: ['stored-commandlog-patterns', connectionId, activeTab, startTime, endTime],
    queryFn: () =>
      metricsApi.getStoredCommandLogPatternAnalysis({ startTime, endTime, type: activeTab, limit: 500 }),
    enabled: enabled && startTime !== undefined && endTime !== undefined,
  });
}
