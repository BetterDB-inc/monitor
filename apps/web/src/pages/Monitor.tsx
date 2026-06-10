import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Feature } from '@betterdb/shared';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { useLicense } from '../hooks/useLicense';
import { monitorApi } from '../api/monitor';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { CreateScheduleModal } from './monitor/create-schedule-modal';
import { MonitorSupportIndicator } from './monitor/monitor-support-indicator';
import { SchedulesTable } from './monitor/schedules-table';
import { SessionsTable } from './monitor/sessions-table';
import { StartSessionModal } from './monitor/start-session-modal';
import { TriggersTable } from './monitor/triggers-table';
import { CommandCaptureControl } from './command-capture/CommandCaptureControl';

export function Monitor() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { hasFeature } = useLicense();
  const triggersEnabled = hasFeature(Feature.MONITOR_ANOMALY_TRIGGER);
  const schedulesEnabled = hasFeature(Feature.MONITOR_SCHEDULED_CAPTURES);

  const [captureType, setCaptureType] = useState<'monitor' | 'client'>('monitor');
  const [startOpen, setStartOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | undefined>();
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | undefined>();

  const sessionsKey = ['monitor', 'sessions', connectionId ?? 'none'];
  const triggersKey = ['monitor', 'triggers', connectionId ?? 'none'];
  const schedulesKey = ['monitor', 'schedules', connectionId ?? 'none'];

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

  const schedulesQuery = usePolling({
    fetcher: () => monitorApi.listSchedules({ connectionId, limit: 100 }),
    interval: 5000,
    enabled: !!connectionId && schedulesEnabled,
    queryKey: schedulesKey,
    refetchKey: connectionId,
  });

  const sessions = sessionsQuery.data ?? [];
  const triggers = triggersQuery.data ?? [];
  const schedules = schedulesQuery.data ?? [];

  async function handleCancelTrigger(id: string) {
    setCancellingId(id);
    try {
      await monitorApi.cancelTrigger(id);
      await queryClient.invalidateQueries({ queryKey: triggersKey });
    } finally {
      setCancellingId(undefined);
    }
  }

  async function handleDeleteSchedule(id: string) {
    setDeletingScheduleId(id);
    try {
      await monitorApi.deleteSchedule(id);
      await queryClient.invalidateQueries({ queryKey: schedulesKey });
    } finally {
      setDeletingScheduleId(undefined);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Monitor / Command Capture</h1>
          <p className="text-sm text-muted-foreground">
            {captureType === 'monitor'
              ? 'On-demand command capture sessions for Valkey/Redis instances via MONITOR. ' +
                'Start, stop, and review past sessions for the currently selected connection.'
              : 'Capture commands from your application via the @betterdb/iovalkey-capture ' +
                'client wrapper. Start a capture window and instrumented clients will ship ' +
                'their commands here.'}
          </p>
        </div>
        {captureType === 'monitor' && (
          <div className="flex items-center gap-3">
            <MonitorSupportIndicator connectionId={connectionId} />
            <Button onClick={() => setStartOpen(true)} disabled={!connectionId}>
              Start session
            </Button>
          </div>
        )}
      </header>

      <Tabs
        value={captureType}
        onValueChange={(v) => setCaptureType(v as 'monitor' | 'client')}
      >
        <TabsList>
          <TabsTrigger value="monitor">Server (MONITOR)</TabsTrigger>
          <TabsTrigger value="client">Client Library</TabsTrigger>
        </TabsList>
      </Tabs>

      {captureType === 'client' && <CommandCaptureControl />}

      {captureType === 'monitor' && (
      <Tabs defaultValue="sessions" className="space-y-4">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          {triggersEnabled && <TabsTrigger value="triggers">Triggers</TabsTrigger>}
          {schedulesEnabled && <TabsTrigger value="schedules">Scheduled</TabsTrigger>}
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

        {schedulesEnabled && (
          <TabsContent value="schedules">
            <Card>
              <CardContent className="space-y-4 pt-6">
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => setScheduleOpen(true)}
                    disabled={!connectionId}
                  >
                    New schedule
                  </Button>
                </div>
                <SchedulesTable
                  schedules={schedules}
                  isLoading={schedulesQuery.loading}
                  onDelete={handleDeleteSchedule}
                  deletingId={deletingScheduleId}
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
      )}

      {connectionId && (
        <StartSessionModal
          connectionId={connectionId}
          open={startOpen}
          onOpenChange={setStartOpen}
          onStarted={(session) => {
            void queryClient.invalidateQueries({ queryKey: sessionsKey });
            navigate(`/monitor/sessions/${session.id}`);
          }}
        />
      )}

      {connectionId && schedulesEnabled && (
        <CreateScheduleModal
          connectionId={connectionId}
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
        />
      )}
    </div>
  );
}
