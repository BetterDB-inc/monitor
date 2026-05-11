import type { StoredCaptureSession } from '@betterdb/shared';
import { fetchApi } from './client';

export type { StoredCaptureSession };

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
};
