import type { StoredCaptureSession } from '@betterdb/shared';
import { fetchApi } from './client';

export type { StoredCaptureSession };

export interface ListSessionsParams {
  connectionId?: string;
  limit?: number;
  offset?: number;
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
};
