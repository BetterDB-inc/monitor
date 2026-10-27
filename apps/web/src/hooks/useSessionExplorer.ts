import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SessionNamespace } from '@betterdb/shared';
import { sessionExplorerApi } from '../api/session-explorer';

const ROOT = 'session-explorer';

const ON_DEMAND = { staleTime: Infinity, refetchOnWindowFocus: false } as const;

export const sessionExplorerKeys = {
  namespaces: (connectionId?: string) => [ROOT, connectionId, 'namespaces'] as const,
  sessions: (connectionId: string | undefined, nsId: string) =>
    [...sessionExplorerKeys.namespaces(connectionId), nsId, 'sessions'] as const,
  oversize: (connectionId: string | undefined, nsId: string) =>
    [...sessionExplorerKeys.namespaces(connectionId), nsId, 'oversize'] as const,
  session: (connectionId: string | undefined, nsId: string, sessionId: string) =>
    [...sessionExplorerKeys.namespaces(connectionId), nsId, 'session', sessionId] as const,
};

export function upsertNamespace(
  list: SessionNamespace[] | undefined,
  ns: SessionNamespace,
): SessionNamespace[] {
  const current = list ?? [];
  return current.some((n) => n.id === ns.id)
    ? current.map((n) => (n.id === ns.id ? ns : n))
    : [...current, ns];
}

export function useSessionNamespaces(connectionId?: string) {
  return useQuery({
    queryKey: sessionExplorerKeys.namespaces(connectionId),
    queryFn: ({ signal }) => sessionExplorerApi.listNamespaces(signal),
    enabled: !!connectionId,
  });
}

export function useSessionList(connectionId: string | undefined, nsId: string | null) {
  return useQuery({
    queryKey: sessionExplorerKeys.sessions(connectionId, nsId ?? ''),
    queryFn: ({ signal }) => sessionExplorerApi.listSessions(nsId as string, signal),
    enabled: !!connectionId && !!nsId,
    ...ON_DEMAND,
  });
}

export function useOversizeSessions(
  connectionId: string | undefined,
  nsId: string | null,
  entitled: boolean,
): Set<string> | null {
  const { data } = useQuery({
    queryKey: sessionExplorerKeys.oversize(connectionId, nsId ?? ''),
    queryFn: ({ signal }) => sessionExplorerApi.oversize(nsId as string, signal),
    enabled: entitled && !!connectionId && !!nsId,
    ...ON_DEMAND,
  });
  return useMemo(
    () => (entitled && data ? new Set(data.sessionIds) : null),
    [entitled, data],
  );
}

export function useSessionDetail(
  connectionId: string | undefined,
  nsId: string | null,
  sessionId: string | null,
) {
  return useQuery({
    queryKey: sessionExplorerKeys.session(connectionId, nsId ?? '', sessionId ?? ''),
    queryFn: ({ signal }) =>
      sessionExplorerApi.getSession(nsId as string, sessionId as string, signal),
    enabled: !!connectionId && !!nsId && !!sessionId,
    ...ON_DEMAND,
  });
}
