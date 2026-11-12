import { fetchApi } from './client';
import type {
  SessionDetail,
  SessionExport,
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

const filenameOf = (sessionId: string): string =>
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
    const data = await fetchApi<SessionExport>(`${sessionPath(id, sessionId)}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filenameOf(sessionId);
    anchor.click();
    URL.revokeObjectURL(url);
  },
};
