import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { monitorApi } from '../api/monitor';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { SessionsTable } from './monitor/sessions-table';
import { StartSessionModal } from './monitor/start-session-modal';

export function Monitor() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;
  const queryClient = useQueryClient();
  const [startOpen, setStartOpen] = useState(false);

  const queryKey = ['monitor', 'sessions', connectionId ?? 'none'];

  const { data, loading } = usePolling({
    fetcher: () => monitorApi.listSessions({ connectionId, limit: 100 }),
    interval: 5000,
    enabled: !!connectionId,
    queryKey,
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
        <Button onClick={() => setStartOpen(true)} disabled={!connectionId}>
          Start session
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <SessionsTable sessions={sessions} isLoading={loading} />
        </CardContent>
      </Card>

      {connectionId && (
        <StartSessionModal
          connectionId={connectionId}
          open={startOpen}
          onOpenChange={setStartOpen}
          onStarted={() => {
            void queryClient.invalidateQueries({ queryKey });
          }}
        />
      )}
    </div>
  );
}
