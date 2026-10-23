import { ApiError, apiUrl, fetchApi, getCurrentConnectionId } from './client';
import type {
  SessionDetail,
  SessionListResponse,
  SessionNamespace,
  SessionNamespaceInput,
  SessionOversizeResponse,
  SessionPreview,
} from '@betterdb/shared';

const BASE = '/session-explorer/namespaces';

const namespacePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const sessionPath = (id: string, sessionId: string) =>
  `${namespacePath(id)}/sessions/${encodeURIComponent(sessionId)}`;

const filenameOf = (disposition: string | null, sessionId: string): string =>
  disposition?.match(/filename="([^"]+)"/)?.[1] ??
  `session-${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

export const sessionExplorerApi = {
  listNamespaces: (signal?: AbortSignal) => fetchApi<SessionNamespace[]>(BASE, { signal }),
  createNamespace: (input: SessionNamespaceInput) =>
    fetchApi<SessionNamespace>(BASE, { method: 'POST', body: JSON.stringify(input) }),
  updateNamespace: (id: string, input: SessionNamespaceInput) =>
    fetchApi<SessionNamespace>(namespacePath(id), { method: 'PUT', body: JSON.stringify(input) }),
  deleteNamespace: (id: string) => fetchApi<void>(namespacePath(id), { method: 'DELETE' }),
  preview: (input: SessionNamespaceInput) =>
    fetchApi<SessionPreview>(`${BASE}/preview`, { method: 'POST', body: JSON.stringify(input) }),
  listSessions: (id: string, signal?: AbortSignal) =>
    fetchApi<SessionListResponse>(`${namespacePath(id)}/sessions`, { signal }),
  getSession: (id: string, sessionId: string, signal?: AbortSignal) =>
    fetchApi<SessionDetail>(sessionPath(id, sessionId), { signal }),
  oversize: (id: string, signal?: AbortSignal) =>
    fetchApi<SessionOversizeResponse>(`${namespacePath(id)}/oversize`, { signal }),
  exportSession: async (id: string, sessionId: string): Promise<void> => {
    const connectionId = getCurrentConnectionId();
    const response = await fetch(apiUrl(`${sessionPath(id, sessionId)}/export`), {
      credentials: 'include',
      headers: connectionId ? { 'x-connection-id': connectionId } : {},
    });
    if (!response.ok) {
      throw new ApiError(`Export failed: ${response.status}`, response.status);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filenameOf(response.headers.get('content-disposition'), sessionId);
    anchor.click();
    URL.revokeObjectURL(url);
  },
};
