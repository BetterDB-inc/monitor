import { fetchApi } from './client';
import type { KeyPatternSnapshot, KeyAnalyticsSummary, PatternTrend, HotKeyEntry, KeySizeDistribution } from '@betterdb/shared';

export type { KeyPatternSnapshot, KeyAnalyticsSummary, PatternTrend, HotKeyEntry, KeySizeDistribution };

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

  triggerCollection: (deep?: boolean) => {
    const path = deep ? '/key-analytics/collect?deep=true' : '/key-analytics/collect';
    return fetchApi<{ message: string; status: string }>(path, { method: 'POST' });
  },

  getKeySizes: () => {
    return fetchApi<KeySizeDistribution>('/key-analytics/key-sizes');
  },

  getLargestKeys: (options?: { limit?: number; startTime?: number; endTime?: number; latest?: boolean; oldest?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.startTime) params.append('startTime', options.startTime.toString());
    if (options?.endTime) params.append('endTime', options.endTime.toString());
    if (options?.latest !== undefined) params.append('latest', options.latest ? 'true' : 'false');
    if (options?.oldest) params.append('oldest', 'true');
    const query = params.toString();
    return fetchApi<HotKeyEntry[]>(query ? `/key-analytics/largest-keys?${query}` : '/key-analytics/largest-keys');
  },

  getHotKeys: (options?: { limit?: number; startTime?: number; endTime?: number; latest?: boolean; oldest?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.startTime) params.append('startTime', options.startTime.toString());
    if (options?.endTime) params.append('endTime', options.endTime.toString());
    if (options?.latest) params.append('latest', 'true');
    if (options?.oldest) params.append('oldest', 'true');
    const query = params.toString();
    return fetchApi<HotKeyEntry[]>(query ? `/key-analytics/hot-keys?${query}` : '/key-analytics/hot-keys');
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
