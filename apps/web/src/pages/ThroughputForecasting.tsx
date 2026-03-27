import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '../hooks/useConnection';
import { usePolling } from '../hooks/usePolling';
import { metricsApi } from '../api/metrics';
import type {
  ThroughputForecast,
  ThroughputSettings,
  ThroughputSettingsUpdate,
} from '@betterdb/shared';
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
  const [settings, setSettings] = useState<ThroughputSettings | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const saveTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const debounceTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const { data: forecast, refresh: refreshForecast } = usePolling<ThroughputForecast>({
    fetcher: (signal?: AbortSignal) => metricsApi.getThroughputForecast(signal),
    interval: 30_000,
    enabled: true,
    refetchKey: currentConnection?.id,
  });

  // Load settings
  useEffect(() => {
    metricsApi
      .getThroughputSettings()
      .then(setSettings)
      .catch(() => {});
  }, [currentConnection?.id]);

  // Chart data
  const [chartData, setChartData] = useState<Array<{ time: number; ops: number; label: string }>>(
    [],
  );
  useEffect(() => {
    if (!settings) return;
    const now = Date.now();
    metricsApi
      .getStoredMemorySnapshots({ startTime: now - settings.rollingWindowMs, limit: 1500 })
      .then((snapshots) => {
        const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
        setChartData(
          sorted.map((s) => ({
            time: s.timestamp,
            ops: s.opsPerSec,
            label: formatTime(s.timestamp),
          })),
        );
      })
      .catch(() => {});
  }, [currentConnection?.id, forecast, settings]);

  const updateSetting = useCallback(
    (updates: ThroughputSettingsUpdate) => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
      setSettings((prev: ThroughputSettings | null) =>
        prev ? { ...prev, ...updates, updatedAt: Date.now() } : prev,
      );

      debounceTimeout.current = setTimeout(async () => {
        try {
          const updated = await metricsApi.updateThroughputSettings(updates);
          setSettings(updated);
          setSaveStatus('saved');
          void refreshForecast();
          if (saveTimeout.current) clearTimeout(saveTimeout.current);
          saveTimeout.current = setTimeout(() => setSaveStatus('idle'), 2000);
        } catch {
          setSaveStatus('error');
        }
      }, 500);
    },
    [refreshForecast],
  );

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

      <SettingsPanel settings={settings} onUpdate={updateSetting} saveStatus={saveStatus} />

      {forecast.insufficientData ? (
        <InsufficientData forecast={forecast} />
      ) : (
        <>
          <ForecastCard forecast={forecast} />
          <ThroughputChart chartData={chartData} forecast={forecast} settings={settings} />
        </>
      )}
    </div>
  );
}
