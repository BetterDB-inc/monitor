import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { monitorApi } from '../api/monitor';
import { useMonitorTail } from '../hooks/useMonitorTail';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { FiltersAndExport } from './monitor/filters-and-export';
import { SessionStatusBadge } from './monitor/session-status-badge';
import { TailView } from './monitor/tail-view';

export function MonitorSession() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? null;
  const tail = useMonitorTail(sessionId);

  const { data, isLoading, error } = useQuery({
    queryKey: ['monitor', 'session', sessionId],
    queryFn: () => monitorApi.getSession(sessionId!),
    enabled: !!sessionId,
    refetchInterval: (q) => {
      const s = q.state.data;
      // Keep polling while running so the header reflects the live counters.
      return s?.status === 'running' ? 2000 : false;
    },
  });

  if (!sessionId) {
    return <p className="text-sm text-destructive">Missing session id.</p>;
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading session…</p>;
  }

  if (error) {
    return <p className="text-sm text-destructive">Failed to load session: {(error as Error).message}</p>;
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">Session not found.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/monitor"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to MONITOR
        </Link>
      </div>

      <header className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-mono text-lg font-semibold tracking-tight">{data.id}</h1>
          <SessionStatusBadge status={data.status} />
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
          <div>
            <dt className="uppercase tracking-wide">Started</dt>
            <dd className="font-mono">{new Date(data.startedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide">Source</dt>
            <dd className="font-mono">{data.source}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide">Lines</dt>
            <dd className="font-mono">{data.lineCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide">Termination</dt>
            <dd className="font-mono">{data.terminationReason ?? '—'}</dd>
          </div>
        </dl>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Live tail</CardTitle>
        </CardHeader>
        <CardContent>
          <TailView tail={tail} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Filters &amp; export</CardTitle>
        </CardHeader>
        <CardContent>
          <FiltersAndExport sessionId={sessionId} bufferLines={tail.lines} />
        </CardContent>
      </Card>
    </div>
  );
}
