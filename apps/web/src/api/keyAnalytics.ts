import { fetchApi } from './client';
import type { KeyPatternSnapshot, KeyAnalyticsSummary, PatternTrend } from '@betterdb/shared';

export type { KeyPatternSnapshot, KeyAnalyticsSummary, PatternTrend };

export const keyAnalyticsApi = {
  getSummary: (startTime?: number, endTime?: number) => {
    const params = new URLSearchParams();
    if (startTime) params.append('startTime', startTime.toString());
    if (endTime) params.append('endTime', endTime.toString());
    const query = params.toString();
    return fetchApi<KeyAnalyticsSummary>(query ? `/key-analytics/summary?${query}` : '/key-analytics/summary');
  },

  getPatterns: (options?: { pattern?: string; startTime?: number; endTime?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.pattern) params.append('pattern', options.pattern);
    if (options?.startTime) params.append('startTime', options.startTime.toString());
    if (options?.endTime) params.append('endTime', options.endTime.toString());
    if (options?.limit) params.append('limit', options.limit.toString());
    const query = params.toString();
    return fetchApi<KeyPatternSnapshot[]>(query ? `/key-analytics/patterns?${query}` : '/key-analytics/patterns');
  },

  getPatternTrends: (pattern: string, startTime: number, endTime: number) => {
    const params = new URLSearchParams({ pattern, startTime: startTime.toString(), endTime: endTime.toString() });
    return fetchApi<PatternTrend[]>(`/key-analytics/trends?${params}`);
  },

  triggerCollection: () => {
    return fetchApi<{ message: string; status: string }>('/key-analytics/collect', { method: 'POST' });
  },

  clearOldSnapshots: (olderThan?: number) => {
    const params = new URLSearchParams();
    if (olderThan) params.append('olderThan', olderThan.toString());
    const query = params.toString();
    return fetchApi<{ message: string; deletedCount: number; cutoffTimestamp: number }>(
      query ? `/key-analytics/snapshots?${query}` : '/key-analytics/snapshots',
      { method: 'DELETE' }
    );
  },
};
