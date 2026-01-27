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
  ClusterNode,
  StoredAclEntry,
  AuditStats,
  SlowLogPatternAnalysis,
  StoredClientSnapshot,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  CommandDistributionParams,
  CommandDistributionResponse,
  IdleConnectionsParams,
  IdleConnectionsResponse,
  BufferAnomaliesParams,
  BufferAnomaliesResponse,
  ActivityTimelineParams,
  ActivityTimelineResponse,
  SpikeDetectionParams,
  SpikeDetectionResponse,
} from '../types/metrics';
import type {
  DiscoveredNode,
  NodeStats,
  ClusterSlowlogEntry,
  ClusterClientEntry,
  SlotMigration,
} from '../types/cluster';

export const metricsApi = {
  getHealth: (signal?: AbortSignal) => fetchApi<HealthResponse>('/health', { signal }),
  getInfo: (sectionsOrSignal?: string[] | AbortSignal) => {
    // Handle both (signal) from usePolling and (sections) from direct calls
    if (sectionsOrSignal instanceof AbortSignal) {
      return fetchApi<InfoResponse>('/metrics/info', { signal: sectionsOrSignal });
    }
    const query = sectionsOrSignal ? `?sections=${sectionsOrSignal.join(',')}` : '';
    return fetchApi<InfoResponse>(`/metrics/info${query}`);
  },
  getSlowLog: (count = 50) => fetchApi<SlowLogEntry[]>(`/metrics/slowlog?count=${count}`),
  getSlowLogPatternAnalysis: (count?: number) => {
    const params = count ? `?count=${count}` : '';
    return fetchApi<SlowLogPatternAnalysis>(`/metrics/slowlog/patterns${params}`);
  },
  getCommandLog: (count = 50, type?: CommandLogType) => {
    const query = type ? `?count=${count}&type=${type}` : `?count=${count}`;
    return fetchApi<CommandLogEntry[]>(`/metrics/commandlog${query}`);
  },
  getCommandLogPatternAnalysis: (count?: number, type?: CommandLogType) => {
    const params = new URLSearchParams();
    if (count) params.set('count', count.toString());
    if (type) params.set('type', type);
    const queryString = params.toString();
    return fetchApi<SlowLogPatternAnalysis>(`/metrics/commandlog/patterns${queryString ? `?${queryString}` : ''}`);
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

  // Cluster endpoints
  getClusterInfo: () => fetchApi<Record<string, string>>('/metrics/cluster/info'),
  getClusterNodes: () => fetchApi<ClusterNode[]>('/metrics/cluster/nodes'),
  getSlotStats: (orderBy: 'key-count' | 'cpu-usec' = 'key-count', limit = 100) =>
    fetchApi<SlotStats>(`/metrics/cluster/slot-stats?orderBy=${orderBy}&limit=${limit}`),

  // New cluster monitoring endpoints
  discoverClusterNodes: (signal?: AbortSignal) =>
    fetchApi<DiscoveredNode[]>('/metrics/cluster/nodes/discover', { signal }),
  getClusterNodeStats: (signal?: AbortSignal) =>
    fetchApi<NodeStats[]>('/metrics/cluster/node-stats', { signal }),
  getClusterSlowlog: (limit = 100, signal?: AbortSignal) =>
    fetchApi<ClusterSlowlogEntry[]>(`/metrics/cluster/slowlog?limit=${limit}`, { signal }),
  getClusterClients: (signal?: AbortSignal) =>
    fetchApi<ClusterClientEntry[]>('/metrics/cluster/clients', { signal }),
  getSlotMigrations: (signal?: AbortSignal) =>
    fetchApi<SlotMigration[]>('/metrics/cluster/migrations', { signal }),
  getNodeInfo: (nodeId: string, signal?: AbortSignal) =>
    fetchApi<Record<string, unknown>>(`/metrics/cluster/nodes/${nodeId}/info`, { signal }),

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

  getClientTimeSeries: (startTime: number, endTime: number, bucketSize?: number) => {
    const params = new URLSearchParams({
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      ...(bucketSize && { bucketSize: bucketSize.toString() }),
    });
    return fetchApi<ClientTimeSeriesPoint[]>(`/client-analytics/timeseries?${params}`);
  },
  getClientAnalyticsStats: (startTime?: number, endTime?: number) => {
    const params = new URLSearchParams();
    if (startTime) params.append('startTime', startTime.toString());
    if (endTime) params.append('endTime', endTime.toString());
    const queryString = params.toString();
    return fetchApi<ClientAnalyticsStats>(`/client-analytics/stats${queryString ? `?${queryString}` : ''}`);
  },
  getClientConnectionHistory: (
    identifier: { name?: string; user?: string; addr?: string },
    startTime?: number,
    endTime?: number,
  ) => {
    const params = new URLSearchParams();
    if (identifier.name) params.append('name', identifier.name);
    if (identifier.user) params.append('user', identifier.user);
    if (identifier.addr) params.append('addr', identifier.addr);
    if (startTime) params.append('startTime', startTime.toString());
    if (endTime) params.append('endTime', endTime.toString());
    return fetchApi<StoredClientSnapshot[]>(`/client-analytics/history?${params}`);
  },

  // Advanced Analytics
  getCommandDistribution: (params?: CommandDistributionParams) => {
    const query = new URLSearchParams();
    if (params?.startTime) query.append('startTime', params.startTime.toString());
    if (params?.endTime) query.append('endTime', params.endTime.toString());
    if (params?.groupBy) query.append('groupBy', params.groupBy);
    const queryString = query.toString();
    return fetchApi<CommandDistributionResponse>(`/client-analytics/command-distribution${queryString ? `?${queryString}` : ''}`);
  },

  getIdleConnections: (params?: IdleConnectionsParams) => {
    const query = new URLSearchParams();
    if (params?.idleThresholdSeconds) query.append('idleThresholdSeconds', params.idleThresholdSeconds.toString());
    if (params?.minOccurrences) query.append('minOccurrences', params.minOccurrences.toString());
    const queryString = query.toString();
    return fetchApi<IdleConnectionsResponse>(`/client-analytics/idle-connections${queryString ? `?${queryString}` : ''}`);
  },

  getBufferAnomalies: (params?: BufferAnomaliesParams) => {
    const query = new URLSearchParams();
    if (params?.startTime) query.append('startTime', params.startTime.toString());
    if (params?.endTime) query.append('endTime', params.endTime.toString());
    if (params?.qbufThreshold) query.append('qbufThreshold', params.qbufThreshold.toString());
    if (params?.omemThreshold) query.append('omemThreshold', params.omemThreshold.toString());
    const queryString = query.toString();
    return fetchApi<BufferAnomaliesResponse>(`/client-analytics/buffer-anomalies${queryString ? `?${queryString}` : ''}`);
  },

  getActivityTimeline: (params?: ActivityTimelineParams) => {
    const query = new URLSearchParams();
    if (params?.startTime) query.append('startTime', params.startTime.toString());
    if (params?.endTime) query.append('endTime', params.endTime.toString());
    if (params?.bucketSizeMinutes) query.append('bucketSizeMinutes', params.bucketSizeMinutes.toString());
    if (params?.client) query.append('client', params.client);
    const queryString = query.toString();
    return fetchApi<ActivityTimelineResponse>(`/client-analytics/activity-timeline${queryString ? `?${queryString}` : ''}`);
  },

  detectSpikes: (params?: SpikeDetectionParams) => {
    const query = new URLSearchParams();
    if (params?.startTime) query.append('startTime', params.startTime.toString());
    if (params?.endTime) query.append('endTime', params.endTime.toString());
    if (params?.sensitivityMultiplier) query.append('sensitivityMultiplier', params.sensitivityMultiplier.toString());
    const queryString = query.toString();
    return fetchApi<SpikeDetectionResponse>(`/client-analytics/spike-detection${queryString ? `?${queryString}` : ''}`);
  },

  // Anomaly Detection
  getAnomalyEvents: (params?: { limit?: number; metricType?: string; startTime?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.metricType) query.append('metricType', params.metricType);
    if (params?.startTime) query.append('startTime', params.startTime.toString());
    const queryString = query.toString();
    return fetchApi<any[]>(`/anomaly/events${queryString ? `?${queryString}` : ''}`);
  },

  getAnomalyGroups: (params?: { limit?: number; pattern?: string; startTime?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.pattern) query.append('pattern', params.pattern);
    if (params?.startTime) query.append('startTime', params.startTime.toString());
    const queryString = query.toString();
    return fetchApi<any[]>(`/anomaly/groups${queryString ? `?${queryString}` : ''}`);
  },

  getAnomalySummary: () => fetchApi<any>('/anomaly/summary'),

  getAnomalyBuffers: () => fetchApi<any[]>('/anomaly/buffers'),
};
