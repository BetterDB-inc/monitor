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
  StoredAclEntry,
  AuditStats,
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
  getLatencyDoctor: () => fetchApi<{ report: string }>('/metrics/latency/doctor'),
  getMemoryDoctor: () => fetchApi<{ report: string }>('/metrics/memory/doctor'),

  // Audit Trail
  getAuditEntries: (params?: {
    username?: string;
    reason?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
  }) => {
    const query = new URLSearchParams();
    if (params?.username) query.set('username', params.username);
    if (params?.reason) query.set('reason', params.reason);
    if (params?.startTime) query.set('startTime', params.startTime.toString());
    if (params?.endTime) query.set('endTime', params.endTime.toString());
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const queryString = query.toString();
    return fetchApi<StoredAclEntry[]>(`/audit/entries${queryString ? `?${queryString}` : ''}`);
  },
  getAuditStats: (startTime?: number, endTime?: number) => {
    const query = new URLSearchParams();
    if (startTime) query.set('startTime', startTime.toString());
    if (endTime) query.set('endTime', endTime.toString());
    const queryString = query.toString();
    return fetchApi<AuditStats>(`/audit/stats${queryString ? `?${queryString}` : ''}`);
  },
  getAuditFailedAuth: (startTime?: number, endTime?: number, limit = 100, offset = 0) => {
    const query = new URLSearchParams();
    if (startTime) query.set('startTime', startTime.toString());
    if (endTime) query.set('endTime', endTime.toString());
    query.set('limit', limit.toString());
    query.set('offset', offset.toString());
    return fetchApi<StoredAclEntry[]>(`/audit/failed-auth?${query.toString()}`);
  },
  getAuditByUser: (username: string, startTime?: number, endTime?: number, limit = 100, offset = 0) => {
    const query = new URLSearchParams({ username });
    if (startTime) query.set('startTime', startTime.toString());
    if (endTime) query.set('endTime', endTime.toString());
    query.set('limit', limit.toString());
    query.set('offset', offset.toString());
    return fetchApi<StoredAclEntry[]>(`/audit/by-user?${query.toString()}`);
  },
};
