import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, OctagonX } from 'lucide-react';
import { Feature } from '@betterdb/shared';
import { monitorApi } from '../api/monitor';
import { useMonitorTail } from '../hooks/useMonitorTail';
import { useLicense } from '../hooks/useLicense';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { CompareCapturesPanel } from './monitor/compare-captures-panel';
import { CrossReferencePanel } from './monitor/cross-reference-panel';
import { FiltersAndExport } from './monitor/filters-and-export';
import { SessionStatusBadge } from './monitor/session-status-badge';
import { TailView } from './monitor/tail-view';

export function MonitorSession() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? null;
  const tail = useMonitorTail(sessionId);
  const { hasFeature } = useLicense();
  const compareEnabled = hasFeature(Feature.MONITOR_CAPTURE_DIFF);
  const queryClient = useQueryClient();

  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const handleStop = async () => {
    if (!sessionId) return;
    setStopping(true);
    setStopError(null);
    try {
      await monitorApi.stopSession(sessionId);
      await queryClient.invalidateQueries({ queryKey: ['monitor', 'session', sessionId] });
      setStopDialogOpen(false);
    } catch (err) {
      setStopError((err as Error).message);
    } finally {
      setStopping(false);
    }
  };

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
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-mono text-lg font-semibold tracking-tight">{data.id}</h1>
          <div className="flex items-center gap-2">
            <SessionStatusBadge status={data.status} />
            {data.status === 'running' && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setStopDialogOpen(true)}
              >
                <OctagonX className="h-3.5 w-3.5" />
                Stop
              </Button>
            )}
          </div>
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
        {data.nodeSegments && data.nodeSegments.length > 0 && (
          <div className="rounded-md border border-border p-3 text-xs">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Fan-out segments ({data.nodeSegments.length} nodes)
            </div>
            <ul className="space-y-1">
              {data.nodeSegments.map((s) => (
                <li key={s.nodeId} className="flex items-center justify-between gap-2 font-mono">
                  <span>
                    {s.address}{' '}
                    <SessionStatusBadge status={s.status} />
                  </span>
                  <span className="text-muted-foreground">
                    {s.lineCount.toLocaleString()} lines · {s.terminationReason ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
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
          <CardTitle>Cross-reference</CardTitle>
        </CardHeader>
        <CardContent>
          <CrossReferencePanel sessionId={sessionId} />
        </CardContent>
      </Card>

      {compareEnabled && (
        <Card>
          <CardHeader>
            <CardTitle>Compare with another capture</CardTitle>
          </CardHeader>
          <CardContent>
            <CompareCapturesPanel sessionId={sessionId} connectionId={data.connectionId} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Filters &amp; export</CardTitle>
        </CardHeader>
        <CardContent>
          <FiltersAndExport sessionId={sessionId} bufferLines={tail.lines} />
        </CardContent>
      </Card>

      <Dialog open={stopDialogOpen} onOpenChange={setStopDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop capture session?</DialogTitle>
            <DialogDescription>
              This will immediately terminate the MONITOR connection to the server. The capture
              cannot be resumed — all commands received so far are preserved and remain
              available for analysis and export.
            </DialogDescription>
          </DialogHeader>
          {stopError && <p className="text-sm text-destructive">{stopError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopDialogOpen(false)} disabled={stopping}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleStop} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
