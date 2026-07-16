import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';
import type { CommandLogType, LogSortBy } from '../types/metrics';

export const COMMAND_LOG_PAGE_SIZE = 100;

interface UseStoredCommandLogOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  activeTab: CommandLogType;
  page: number;
  sortBy?: LogSortBy;
  enabled?: boolean;
}

export function useStoredCommandLog({
  connectionId,
  startTime,
  endTime,
  activeTab,
  page,
  sortBy,
  enabled = true,
}: UseStoredCommandLogOptions) {
  const hasTimeRange = startTime !== undefined && endTime !== undefined;
  return useQuery({
    queryKey: ['stored-commandlog', connectionId, activeTab, startTime, endTime, page, sortBy ?? 'recent'],
    queryFn: async () => {
      const offset = page * COMMAND_LOG_PAGE_SIZE;
      const entries = await metricsApi.getStoredCommandLog({
        startTime,
        endTime,
        type: activeTab,
        limit: COMMAND_LOG_PAGE_SIZE + 1,
        offset,
        ...(sortBy === 'magnitude' ? { sortBy } : {}),
      });
      const hasMore = entries.length > COMMAND_LOG_PAGE_SIZE;
      return {
        entries: hasMore ? entries.slice(0, COMMAND_LOG_PAGE_SIZE) : entries,
        hasMore,
      };
    },
    // Magnitude sort queries the full stored history, so it works without a
    // time range; recency-sorted stored queries still require one (the live
    // poller covers the unfiltered case).
    enabled: enabled && (hasTimeRange || sortBy === 'magnitude'),
    placeholderData: keepPreviousData,
  });
}
