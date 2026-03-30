import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';
import type { CommandLogType } from '../types/metrics';

export const COMMAND_LOG_PAGE_SIZE = 100;

interface UseStoredCommandLogOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  activeTab: CommandLogType;
  page: number;
  enabled?: boolean;
}

export function useStoredCommandLog({
  connectionId,
  startTime,
  endTime,
  activeTab,
  page,
  enabled = true,
}: UseStoredCommandLogOptions) {
  return useQuery({
    queryKey: ['stored-commandlog', connectionId, activeTab, startTime, endTime, page],
    queryFn: async () => {
      const offset = page * COMMAND_LOG_PAGE_SIZE;
      const entries = await metricsApi.getStoredCommandLog({
        startTime,
        endTime,
        type: activeTab,
        limit: COMMAND_LOG_PAGE_SIZE + 1,
        offset,
      });
      const hasMore = entries.length > COMMAND_LOG_PAGE_SIZE;
      return {
        entries: hasMore ? entries.slice(0, COMMAND_LOG_PAGE_SIZE) : entries,
        hasMore,
      };
    },
    enabled: enabled && startTime !== undefined && endTime !== undefined,
    placeholderData: keepPreviousData,
  });
}
