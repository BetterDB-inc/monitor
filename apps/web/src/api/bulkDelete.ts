import { fetchApi } from './client';

export type BulkDeleteScope = 'node' | 'cluster';
export type BulkDeleteMode = 'dry-run' | 'execute';
export type BulkDeleteJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SkippedNode {
  node: string;
  error: string;
}

export interface BulkDeleteRequest {
  match: string;
  type?: string;
  count?: number;
  scope?: BulkDeleteScope;
  maxKeys?: number;
  batchPauseMs?: number;
  confirmDeleteAll?: boolean;
}

export interface NodeProgress {
  node: string;
  matched: number;
  deleted: number;
  batches: number;
  cursorDone: boolean;
}

/** Live/final view of a preview (dry-run) or execute job. */
export interface BulkDeleteJob {
  id: string;
  connectionId: string;
  mode: BulkDeleteMode;
  scope: BulkDeleteScope;
  status: BulkDeleteJobStatus;
  match: string;
  type: string | null;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  matched: number;
  deleted: number;
  batches: number;
  nodesTotal: number;
  nodesDone: number;
  truncated: boolean;
  cancelled: boolean;
  sampleKeys: string[];
  perNode: NodeProgress[];
  skipped: SkippedNode[];
}

export interface BulkDeleteAudit {
  id: string;
  connectionId: string;
  timestamp: number;
  completedAt: number | null;
  status: BulkDeleteJobStatus;
  match: string;
  type: string | null;
  scope: BulkDeleteScope;
  matched: number;
  deleted: number;
  batches: number;
  nodes: number;
  truncated: boolean;
  skippedNodes: string[];
  error: string | null;
  sourceHost: string | null;
  sourcePort: number | null;
}

export const bulkDeleteApi = {
  preview: (request: BulkDeleteRequest) =>
    fetchApi<{ jobId: string; status: BulkDeleteJobStatus }>('/bulk-delete/preview', {
      method: 'POST',
      body: JSON.stringify(request),
    }),

  execute: (request: BulkDeleteRequest) =>
    fetchApi<{ jobId: string; status: BulkDeleteJobStatus }>('/bulk-delete/execute', {
      method: 'POST',
      body: JSON.stringify(request),
    }),

  getJob: (id: string) => fetchApi<BulkDeleteJob>(`/bulk-delete/jobs/${id}`),

  cancelJob: (id: string) =>
    fetchApi<{ cancelled: boolean }>(`/bulk-delete/jobs/${id}/cancel`, { method: 'POST' }),

  getAudits: (limit?: number) => {
    const query = limit ? `?limit=${limit}` : '';
    return fetchApi<BulkDeleteAudit[]>(`/bulk-delete/audits${query}`);
  },
};
