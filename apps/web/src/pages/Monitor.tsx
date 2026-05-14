import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { monitorApi } from '../api/monitor';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { SessionsTable } from './monitor/sessions-table';

export function Monitor() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;

  const { data, loading } = usePolling({
    fetcher: () => monitorApi.listSessions({ connectionId, limit: 100 }),
    interval: 5000,
    enabled: !!connectionId,
    queryKey: ['monitor', 'sessions', connectionId ?? 'none'],
    refetchKey: connectionId,
  });

  const sessions = data ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">MONITOR</h1>
          <p className="text-sm text-muted-foreground">
            On-demand command capture sessions for Valkey/Redis instances. Start, stop, and
            review past sessions for the currently selected connection.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <SessionsTable sessions={sessions} isLoading={loading} />
        </CardContent>
      </Card>
    </div>
  );
}
