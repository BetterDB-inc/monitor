import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Feature,
  type ScalingReadinessSettings,
  type ScalingReadinessSettingsUpdate,
} from '@betterdb/shared';
import { useConnection } from '../hooks/useConnection';
import { useLicense } from '../hooks/useLicense';
import { scalingReadinessApi } from '../api/scaling-readiness';
import { DateRangePicker, type DateRange } from '../components/ui/date-range-picker';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  ReadinessAlertSettings,
  ReadinessBreakdown,
  ReadinessHeader,
  ReadinessHistoryChart,
  ReadinessProLocked,
} from '../components/pages/scaling-readiness';

const DEFAULT_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

export function ScalingReadiness() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;
  const queryClient = useQueryClient();
  const { hasFeature } = useLicense();
  const canUseHistory = hasFeature(Feature.SCALING_READINESS_HISTORY);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const statusReset = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef(new Map<string, ScalingReadinessSettingsUpdate>());
  const inFlight = useRef(new Set<string>());
  const flushRef = useRef<(id: string) => void>(() => {});
  const activeConnection = useRef(connectionId);
  activeConnection.current = connectionId;

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
      if (statusReset.current) clearTimeout(statusReset.current);
      for (const id of [...pending.current.keys()]) flushRef.current(id);
      setSaveStatus('idle');
    },
    [connectionId],
  );

  const { data: readiness, isLoading, isError } = useQuery({
    queryKey: ['scaling-readiness', connectionId],
    queryFn: ({ signal }) => scalingReadinessApi.get(signal),
    enabled: !!connectionId,
    refetchInterval: 60_000,
  });

  const to = dateRange?.to?.getTime();
  const from = dateRange?.from?.getTime();
  const {
    data: history,
    isLoading: historyLoading,
    isError: historyError,
  } = useQuery({
    queryKey: ['scaling-readiness-history', connectionId, from, to],
    queryFn: ({ signal }) => {
      const end = to ?? Date.now();
      return scalingReadinessApi.getHistory(from ?? end - DEFAULT_HISTORY_MS, end, signal);
    },
    enabled: !!connectionId && canUseHistory,
    refetchInterval: dateRange ? false : 60_000,
  });

  const settingsKey = ['scaling-readiness-settings', connectionId];
  const { data: settings } = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => scalingReadinessApi.getSettings(signal),
    enabled: !!connectionId && canUseHistory,
  });

  const flush = (id: string) => {
    const update = pending.current.get(id);
    if (!update || inFlight.current.has(id)) return;
    pending.current.delete(id);
    const key = ['scaling-readiness-settings', id];
    inFlight.current.add(id);
    const isCurrent = () => activeConnection.current === id;
    const hasNewer = () => pending.current.has(id);
    const settle = () => {
      inFlight.current.delete(id);
      if (pending.current.has(id)) flush(id);
    };
    scalingReadinessApi
      .updateSettings(update, id)
      .then(
        (saved) => {
          if (!hasNewer()) queryClient.setQueryData(key, saved);
          if (isCurrent()) {
            setSaveStatus('saved');
            if (statusReset.current) clearTimeout(statusReset.current);
            statusReset.current = setTimeout(() => setSaveStatus('idle'), 2000);
          }
        },
        () => {
          if (!hasNewer()) void queryClient.invalidateQueries({ queryKey: key });
          if (isCurrent()) setSaveStatus('error');
        },
      )
      .finally(settle);
  };
  flushRef.current = flush;

  const updateSettings = (update: ScalingReadinessSettingsUpdate) => {
    if (!connectionId) return;
    pending.current.set(connectionId, { ...pending.current.get(connectionId), ...update });
    queryClient.setQueryData(
      ['scaling-readiness-settings', connectionId],
      (prev: ScalingReadinessSettings | undefined) => (prev ? { ...prev, ...update } : prev),
    );
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => flush(connectionId), 500);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Scaling Readiness</h1>
      {isLoading && !readiness ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : readiness ? (
        <>
          <ReadinessHeader readiness={readiness} />
          <ReadinessBreakdown dimensions={readiness.dimensions} />
        </>
      ) : isError ? (
        <p className="text-sm text-destructive">Could not load scaling readiness</p>
      ) : null}
      {canUseHistory ? (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>History</CardTitle>
              <DateRangePicker value={dateRange} onChange={setDateRange} placeholder="Last 7 days" />
            </CardHeader>
            <CardContent>
              {historyLoading && !history ? (
                <p className="text-sm text-muted-foreground">Loading score history…</p>
              ) : historyError && !history ? (
                <p className="text-sm text-destructive">Could not load score history</p>
              ) : (
                <ReadinessHistoryChart points={history?.points ?? []} />
              )}
            </CardContent>
          </Card>
          {settings ? (
            <ReadinessAlertSettings
              settings={settings}
              onChange={updateSettings}
              saveStatus={saveStatus}
            />
          ) : null}
        </>
      ) : (
        <ReadinessProLocked />
      )}
    </div>
  );
}
