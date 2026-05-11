import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Feature } from '@betterdb/shared';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { useLicense } from '../hooks/useLicense';
import { monitorApi } from '../api/monitor';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { SessionsTable } from './monitor/sessions-table';
import { StartSessionModal } from './monitor/start-session-modal';
import { TriggersTable } from './monitor/triggers-table';

export function Monitor() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;
  const queryClient = useQueryClient();
  const { hasFeature } = useLicense();
  const triggersEnabled = hasFeature(Feature.MONITOR_ANOMALY_TRIGGER);

  const [startOpen, setStartOpen] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | undefined>();

  const sessionsKey = ['monitor', 'sessions', connectionId ?? 'none'];
  const triggersKey = ['monitor', 'triggers', connectionId ?? 'none'];

  const sessionsQuery = usePolling({
    fetcher: () => monitorApi.listSessions({ connectionId, limit: 100 }),
    interval: 5000,
    enabled: !!connectionId,
    queryKey: sessionsKey,
    refetchKey: connectionId,
  });

  const triggersQuery = usePolling({
    fetcher: () => monitorApi.listTriggers({ connectionId, limit: 100 }),
    interval: 5000,
    enabled: !!connectionId && triggersEnabled,
    queryKey: triggersKey,
    refetchKey: connectionId,
  });

  const sessions = sessionsQuery.data ?? [];
  const triggers = triggersQuery.data ?? [];

  async function handleCancelTrigger(id: string) {
    setCancellingId(id);
    try {
      await monitorApi.cancelTrigger(id);
      await queryClient.invalidateQueries({ queryKey: triggersKey });
    } finally {
      setCancellingId(undefined);
    }
  }

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

      <Tabs defaultValue="sessions" className="space-y-4">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          {triggersEnabled && <TabsTrigger value="triggers">Triggers</TabsTrigger>}
        </TabsList>

        <TabsContent value="sessions">
          <Card>
            <CardContent className="pt-6">
              <SessionsTable sessions={sessions} isLoading={sessionsQuery.loading} />
            </CardContent>
          </Card>
        </TabsContent>

        {triggersEnabled && (
          <TabsContent value="triggers">
            <Card>
              <CardContent className="pt-6">
                <TriggersTable
                  triggers={triggers}
                  isLoading={triggersQuery.loading}
                  onCancel={handleCancelTrigger}
                  cancellingId={cancellingId}
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {connectionId && (
        <StartSessionModal
          connectionId={connectionId}
          open={startOpen}
          onOpenChange={setStartOpen}
          onStarted={() => {
            void queryClient.invalidateQueries({ queryKey: sessionsKey });
          }}
        />
      )}
    </div>
  );
}
