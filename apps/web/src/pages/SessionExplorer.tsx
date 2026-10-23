import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Feature, type SessionNamespace } from '@betterdb/shared';
import { useConnection } from '../hooks/useConnection';
import { useLicense } from '../hooks/useLicense';
import {
  sessionExplorerKeys,
  upsertNamespace,
  useOversizeSessions,
  useSessionDetail,
  useSessionList,
  useSessionNamespaces,
} from '../hooks/useSessionExplorer';
import { sessionExplorerApi } from '../api/session-explorer';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { SessionExplorerEmptyState } from '../components/pages/session-explorer/EmptyState';
import { NamespaceSetup } from '../components/pages/session-explorer/NamespaceSetup';
import { SessionList } from '../components/pages/session-explorer/SessionList';
import { SessionDetailPanel } from '../components/pages/session-explorer/SessionDetailPanel';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Request failed');

export function SessionExplorer() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;
  const queryClient = useQueryClient();
  const { hasFeature } = useLicense();
  const entitled = hasFeature(Feature.SESSION_OVERSIZE_FLAGS);

  const [selectedNs, setSelectedNs] = useState<string | null>(null);
  const [editing, setEditing] = useState<SessionNamespace | 'new' | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedNs(null);
    setSessionId(null);
    setEditing(null);
    setActionError(null);
  }, [connectionId]);

  const namespaces = useSessionNamespaces(connectionId);
  const list = namespaces.data ?? [];
  const namespace = list.find((n) => n.id === selectedNs) ?? list[0] ?? null;
  const nsId = namespace?.id ?? null;

  const sessions = useSessionList(connectionId, nsId);
  const oversizeIds = useOversizeSessions(connectionId, nsId, entitled);
  const detail = useSessionDetail(connectionId, nsId, sessionId);

  const selectNamespace = (id: string) => {
    setSelectedNs(id);
    setSessionId(null);
  };

  const onSaved = (ns: SessionNamespace) => {
    setEditing(null);
    queryClient.setQueryData<SessionNamespace[]>(
      sessionExplorerKeys.namespaces(connectionId),
      (old) => upsertNamespace(old, ns),
    );
    selectNamespace(ns.id);
    void queryClient.invalidateQueries({ queryKey: sessionExplorerKeys.namespaces(connectionId) });
  };

  const onDelete = async () => {
    if (!namespace || !window.confirm(`Delete namespace "${namespace.name}"?`)) return;
    setActionError(null);
    try {
      const { id } = namespace;
      await sessionExplorerApi.deleteNamespace(id);
      setSelectedNs(null);
      setSessionId(null);
      queryClient.setQueryData<SessionNamespace[]>(
        sessionExplorerKeys.namespaces(connectionId),
        (old) => old?.filter((n) => n.id !== id),
      );
      await queryClient.invalidateQueries({
        queryKey: sessionExplorerKeys.namespaces(connectionId),
        exact: true,
      });
    } catch (err) {
      setActionError(errorText(err));
    }
  };

  const onExport = async () => {
    if (!nsId || !sessionId) return;
    setExporting(true);
    setActionError(null);
    try {
      await sessionExplorerApi.exportSession(nsId, sessionId);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  const header = (
    <div>
      <h1 className="text-2xl font-bold">Session Explorer</h1>
      <p className="text-sm text-muted-foreground">
        Browse agent and chat session state stored in Valkey. Read-only.
      </p>
    </div>
  );

  if (namespaces.isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (editing) {
    return (
      <div className="space-y-6">
        {header}
        <NamespaceSetup
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? undefined : editing}
          onSaved={onSaved}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  if (namespaces.isError) {
    return (
      <div className="space-y-6">
        {header}
        <Alert variant="destructive">
          <AlertDescription>{errorText(namespaces.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!namespace) {
    return (
      <div className="space-y-6">
        {header}
        <SessionExplorerEmptyState onCreate={() => setEditing('new')} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="session-namespace" className="text-sm font-medium">
          Namespace
        </label>
        <select
          id="session-namespace"
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={namespace.id}
          onChange={(e) => selectNamespace(e.target.value)}
        >
          {list.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
        <span className="font-mono text-xs text-muted-foreground">{namespace.pattern}</span>
        <div className="ms-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            New
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing(namespace)}>
            Edit
          </Button>
          <Button variant="outline" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Sessions</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void sessions.refetch()}
              disabled={sessions.isFetching}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
          </CardHeader>
          <CardContent>
            {sessions.isLoading && <Skeleton className="h-32 w-full" />}
            {sessions.isError && (
              <Alert variant="destructive">
                <AlertDescription>{errorText(sessions.error)}</AlertDescription>
              </Alert>
            )}
            {sessions.data && (
              <SessionList
                data={sessions.data}
                oversizeIds={oversizeIds}
                selectedId={sessionId}
                onSelect={setSessionId}
              />
            )}
          </CardContent>
        </Card>

        <div>
          {!sessionId && (
            <p className="text-sm text-muted-foreground">Select a session to see its timeline.</p>
          )}
          {sessionId && detail.isLoading && <Skeleton className="h-64 w-full" />}
          {sessionId && detail.isError && (
            <Alert variant="destructive">
              <AlertDescription>{errorText(detail.error)}</AlertDescription>
            </Alert>
          )}
          {sessionId && detail.data && (
            <SessionDetailPanel detail={detail.data} onExport={onExport} exporting={exporting} />
          )}
        </div>
      </div>
    </div>
  );
}
