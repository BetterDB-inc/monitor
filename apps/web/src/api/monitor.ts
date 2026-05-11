import type {
  CaptureTriggerStatus,
  StoredCaptureSession,
  StoredCaptureTrigger,
} from '@betterdb/shared';
import { fetchApi } from './client';

export type { StoredCaptureSession, StoredCaptureTrigger, CaptureTriggerStatus };

export interface ListSessionsParams {
  connectionId?: string;
  limit?: number;
  offset?: number;
}

export interface PreflightAcl {
  username: string;
  hasMonitor: boolean;
  setUserSnippet?: string;
  rawRules?: string;
}

export interface PreflightProvider {
  provider:
    | 'aws-elasticache'
    | 'gcp-memorystore'
    | 'redis-cloud'
    | 'upstash'
    | 'self-hosted'
    | 'unknown';
  restrictions: string[];
}

export interface PreflightHealth {
  allow: boolean;
  skipReason?: string;
  signals: {
    memoryPct: number;
    oomEventsRecent: number;
    replicationLagBytes: number;
    failoverInProgress: boolean;
  };
  thresholds: {
    memoryPctThreshold: number;
    replicationLagThresholdBytes: number;
  };
}

export interface PreflightThroughput {
  opsPerSec: number;
  inputKbps: number;
  outputKbps: number;
  durationMs: number;
  estimatedLines: number;
  estimatedBytes: number;
}

export interface PreflightResult {
  connectionId: string;
  provider: PreflightProvider;
  acl: PreflightAcl;
  health: PreflightHealth;
  throughput: PreflightThroughput;
}

export interface StartSessionParams {
  connectionId: string;
  durationMs?: number;
  byteCap?: number;
  lineCap?: number;
  requestedBy?: string;
  targetNodeId?: string;
  fanOut?: boolean;
}

export interface MonitorNodeDescriptor {
  id: string;
  address: string;
  role: 'master' | 'replica';
  healthy: boolean;
}

export interface MonitorNodesResponse {
  isCluster: boolean;
  nodes: MonitorNodeDescriptor[];
}

export type BaselineWindow = '6h' | '24h' | '7d' | 'same-hour-last-week';

export interface CrossReferenceNewShape {
  shape: string;
  cmd: string;
  arity: number | null;
  scriptSha: string | null;
  countInCapture: number;
}

export interface CrossReferenceHotKey {
  key: string;
  countInCapture: number;
  countInBaseline: number;
  rankInCapture: number;
  rankInBaseline: number | null;
}

export interface CrossReferenceSlowlogRegression {
  cmd: string;
  shape: string;
  slowlogCountInSession: number;
  observedRatePerSec: number;
  baselineRatePerSec: number;
  baselineP95RatePerSec: number;
}

export interface CrossReferenceResult {
  sessionId: string;
  baseline: { window: BaselineWindow; startTs: number; endTs: number };
  session: { startTs: number; endTs: number; capturedLineCount: number };
  newShapes: CrossReferenceNewShape[];
  hotKeyDelta: {
    newInTopK: CrossReferenceHotKey[];
    rankChanges: CrossReferenceHotKey[];
  };
  slowlogRegressions: CrossReferenceSlowlogRegression[];
  aclDeltas: {
    auditEntriesInWindow: number;
    counters: {
      aclAccessDeniedAuthDelta: number | null;
      rejectedConnectionsDelta: number | null;
    };
  };
}

export interface ExportFilters {
  command?: string;
  client?: string;
  key?: string;
  afterTs?: number;
  beforeTs?: number;
}

const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3001';

export function buildExportUrl(
  sessionId: string,
  format: 'json' | 'csv',
  filters: ExportFilters = {},
): string {
  const params = new URLSearchParams();
  params.set('format', format);
  if (filters.command) params.set('command', filters.command);
  if (filters.client) params.set('client', filters.client);
  if (filters.key) params.set('key', filters.key);
  if (filters.afterTs !== undefined) params.set('afterTs', String(filters.afterTs));
  if (filters.beforeTs !== undefined) params.set('beforeTs', String(filters.beforeTs));
  return `${API_BASE}/monitor/sessions/${encodeURIComponent(sessionId)}/export?${params.toString()}`;
}

export const monitorApi = {
  listSessions: (params: ListSessionsParams = {}): Promise<StoredCaptureSession[]> => {
    const search = new URLSearchParams();
    if (params.connectionId) search.set('connectionId', params.connectionId);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    const query = search.toString();
    return fetchApi<StoredCaptureSession[]>(
      query ? `/monitor/sessions?${query}` : '/monitor/sessions',
    );
  },

  getSession: (id: string): Promise<StoredCaptureSession> => {
    return fetchApi<StoredCaptureSession>(`/monitor/sessions/${encodeURIComponent(id)}`);
  },

  preflight: (connectionId: string, durationMs?: number): Promise<PreflightResult> => {
    return fetchApi<PreflightResult>('/monitor/sessions/preflight', {
      method: 'POST',
      body: JSON.stringify({ connectionId, durationMs }),
    });
  },

  startSession: (params: StartSessionParams): Promise<StoredCaptureSession> => {
    return fetchApi<StoredCaptureSession>('/monitor/sessions', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  listConnectionNodes: (connectionId: string): Promise<MonitorNodesResponse> => {
    return fetchApi<MonitorNodesResponse>(
      `/monitor/connections/${encodeURIComponent(connectionId)}/nodes`,
    );
  },

  crossReference: (sessionId: string, baseline: BaselineWindow): Promise<CrossReferenceResult> => {
    return fetchApi<CrossReferenceResult>(
      `/monitor/sessions/${encodeURIComponent(sessionId)}/cross-reference?baseline=${baseline}`,
    );
  },

  listTriggers: (params: ListTriggersParams = {}): Promise<StoredCaptureTrigger[]> => {
    const search = new URLSearchParams();
    if (params.connectionId) {
      search.set('connectionId', params.connectionId);
    }
    if (params.status) {
      search.set('status', params.status);
    }
    if (params.limit !== undefined) {
      search.set('limit', String(params.limit));
    }
    if (params.offset !== undefined) {
      search.set('offset', String(params.offset));
    }
    const query = search.toString();
    return fetchApi<StoredCaptureTrigger[]>(
      query ? `/monitor/triggers?${query}` : '/monitor/triggers',
    );
  },

  createTrigger: (params: CreateTriggerParams): Promise<StoredCaptureTrigger> => {
    return fetchApi<StoredCaptureTrigger>('/monitor/triggers', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  cancelTrigger: (id: string): Promise<{ cancelled: boolean }> => {
    return fetchApi<{ cancelled: boolean }>(
      `/monitor/triggers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  },
};

export interface ListTriggersParams {
  connectionId?: string;
  status?: CaptureTriggerStatus;
  limit?: number;
  offset?: number;
}

export interface CreateTriggerParams {
  connectionId: string;
  metricType: string;
  anomalyType: string;
  expiresAt?: number;
  createdBy?: string;
}
