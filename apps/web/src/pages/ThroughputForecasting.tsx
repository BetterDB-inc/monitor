import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnection } from '../hooks/useConnection';
import { metricsApi } from '../api/metrics';
import type { ThroughputSettingsUpdate } from '@betterdb/shared';
import {
  ForecastCard,
  formatTime,
  Loading,
  SettingsPanel,
  ThroughputChart,
  Disabled,
  InsufficientData,
} from '../components/pages/throughput-forecasting';

export function ThroughputForecasting() {
  const { currentConnection } = useConnection();
  const queryClient = useQueryClient();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const saveTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const debounceTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const connectionId = currentConnection?.id;

  const { data: forecast } = useQuery({
    queryKey: ['throughput-forecast', connectionId],
    queryFn: ({ signal }) => metricsApi.getThroughputForecast(signal),
    refetchInterval: 30_000,
  });

  const { data: settings } = useQuery({
    queryKey: ['throughput-settings', connectionId],
    queryFn: ({ signal }) => metricsApi.getThroughputSettings(signal),
  });

  const { data: chartData = [] } = useQuery({
    queryKey: ['throughput-chart', connectionId, settings?.rollingWindowMs],
    queryFn: async () => {
      const now = Date.now();
      const snapshots = await metricsApi.getStoredMemorySnapshots({
        startTime: now - settings!.rollingWindowMs,
        limit: 1500,
      });
      return [...snapshots]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((s) => ({ time: s.timestamp, ops: s.opsPerSec, label: formatTime(s.timestamp) }));
    },
    enabled: !!settings,
    refetchInterval: 30_000,
  });

  const updateSetting = (updates: ThroughputSettingsUpdate) => {
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);

    // Optimistic update
    queryClient.setQueryData(
      ['throughput-settings', connectionId],
      (prev: typeof settings) => (prev ? { ...prev, ...updates, updatedAt: Date.now() } : prev),
    );

    debounceTimeout.current = setTimeout(async () => {
      try {
        const updated = await metricsApi.updateThroughputSettings(updates);
        queryClient.setQueryData(['throughput-settings', connectionId], updated);
        setSaveStatus('saved');
        await queryClient.invalidateQueries({ queryKey: ['throughput-forecast', connectionId] });
        if (saveTimeout.current) clearTimeout(saveTimeout.current);
        saveTimeout.current = setTimeout(() => setSaveStatus('idle'), 2000);
      } catch {
        // Revert optimistic update
        await queryClient.invalidateQueries({ queryKey: ['throughput-settings', connectionId] });
        setSaveStatus('error');
      }
    }, 500);
  };

  // ── Page States ──

  if (!forecast || !settings) {
    return <Loading />;
  }

  if (!forecast.enabled) {
    return <Disabled updateSetting={updateSetting} settings={settings} saveStatus={saveStatus} />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Throughput Forecast</h1>

      {forecast.insufficientData ? (
        <InsufficientData forecast={forecast} />
      ) : (
        <>
          <ForecastCard forecast={forecast} />
          <ThroughputChart chartData={chartData} forecast={forecast} settings={settings} />
        </>
      )}
      <SettingsPanel settings={settings} onUpdate={updateSetting} saveStatus={saveStatus} />
    </div>
  );
}
