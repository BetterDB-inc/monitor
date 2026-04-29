import type {
  AppliedResult,
  ProposalStatus,
  StoredCacheProposal,
  StoredCacheProposalAudit,
} from '@betterdb/shared';
import { fetchApi } from './client';

export interface ApprovalResultPayload {
  proposal_id: string;
  status: ProposalStatus;
  applied_result: AppliedResult | null;
}

export interface RejectResultPayload {
  proposal_id: string;
  status: ProposalStatus;
}

export interface ProposalDetailPayload {
  proposal: StoredCacheProposal;
  audit: StoredCacheProposalAudit[];
}

export interface ListProposalsParams {
  cacheName?: string;
  status?: ProposalStatus;
  limit?: number;
  offset?: number;
}

function buildQuery(params: ListProposalsParams): string {
  const search = new URLSearchParams();
  if (params.cacheName) {
    search.set('cache_name', params.cacheName);
  }
  if (params.status) {
    search.set('status', params.status);
  }
  if (typeof params.limit === 'number') {
    search.set('limit', String(params.limit));
  }
  if (typeof params.offset === 'number') {
    search.set('offset', String(params.offset));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export interface EditAndApproveBody {
  new_threshold?: number;
  new_ttl_seconds?: number;
  actor?: string;
}

export const cacheProposalsApi = {
  listPending(params: ListProposalsParams = {}): Promise<StoredCacheProposal[]> {
    return fetchApi(`/cache-proposals/pending${buildQuery(params)}`);
  },

  listHistory(params: ListProposalsParams = {}): Promise<StoredCacheProposal[]> {
    return fetchApi(`/cache-proposals/history${buildQuery(params)}`);
  },

  get(id: string): Promise<ProposalDetailPayload> {
    return fetchApi(`/cache-proposals/${id}`);
  },

  approve(id: string, actor?: string): Promise<ApprovalResultPayload> {
    return fetchApi(`/cache-proposals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(actor ? { actor } : {}),
    });
  },

  reject(id: string, reason: string | null, actor?: string): Promise<RejectResultPayload> {
    return fetchApi(`/cache-proposals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason, ...(actor ? { actor } : {}) }),
    });
  },

  editAndApprove(id: string, body: EditAndApproveBody): Promise<ApprovalResultPayload> {
    return fetchApi(`/cache-proposals/${id}/edit-and-approve`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};
