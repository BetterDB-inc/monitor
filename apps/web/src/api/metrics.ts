import { fetchApi } from './client';
import type {
  HealthResponse,
  InfoResponse,
  SlowLogEntry,
  CommandLogEntry,
  CommandLogType,
  LatencyEvent,
  LatencyHistoryEntry,
  LatencyHistogram,
  MemoryStats,
  ClientInfo,
  AclLogEntry,
  SlotStats,
  DatabaseCapabilities,
} from '../types/metrics';

export const metricsApi = {
  getHealth: () => fetchApi<HealthResponse>('/health'),
  getInfo: (sections?: string[]) => {
    const query = sections ? `?sections=${sections.join(',')}` : '';
    return fetchApi<InfoResponse>(`/metrics/info${query}`);
  },
  getSlowLog: (count = 50) => fetchApi<SlowLogEntry[]>(`/metrics/slowlog?count=${count}`),
  getCommandLog: (count = 50, type?: CommandLogType) => {
    const query = type ? `?count=${count}&type=${type}` : `?count=${count}`;
    return fetchApi<CommandLogEntry[]>(`/metrics/commandlog${query}`);
  },
  getLatencyLatest: () => fetchApi<LatencyEvent[]>('/metrics/latency/latest'),
  getLatencyHistory: (eventName: string) =>
    fetchApi<LatencyHistoryEntry[]>(`/metrics/latency/history/${eventName}`),
  getLatencyHistogram: (commands?: string[]) => {
    const query = commands?.length ? `?commands=${commands.join(',')}` : '';
    return fetchApi<Record<string, LatencyHistogram>>(`/metrics/latency/histogram${query}`);
  },
  getMemoryStats: () => fetchApi<MemoryStats>('/metrics/memory/stats'),
  getClients: () => fetchApi<ClientInfo[]>('/metrics/clients'),
  getAclLog: (count = 50) => fetchApi<AclLogEntry[]>(`/metrics/acl/log?count=${count}`),
  getSlotStats: (orderBy: 'key-count' | 'cpu-usec' = 'key-count', limit = 100) =>
    fetchApi<SlotStats>(`/metrics/cluster/slot-stats?orderBy=${orderBy}&limit=${limit}`),
  getDbSize: () => fetchApi<{ size: number }>('/metrics/dbsize'),
  getRole: () => fetchApi<{ role: string; replicationOffset?: number; replicas?: unknown[] }>('/metrics/role'),
};
