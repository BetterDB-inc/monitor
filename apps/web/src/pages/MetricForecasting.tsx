import { useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useConnection } from '../hooks/useConnection';
import { metricForecastingApi } from '../api/metric-forecasting';
import { metricsApi } from '../api/metrics';
import { METRIC_EXTRACTORS } from './metric-forecasting-extractors';
import {
  METRIC_KIND_META,
  ALL_METRIC_KINDS,
  type MetricKind,
  type MetricForecastSettingsUpdate,
} from '@betterdb/shared';
import {
  MetricForecastCard,
  MetricChart,
  MetricSettingsPanel,
  MetricLoading,
  MetricDisabled,
  MetricInsufficientData,
  formatTime,
} from '../components/pages/metric-forecasting';

const TAB_LABELS: Record<MetricKind, string> = {
  opsPerSec: 'Ops',
  usedMemory: 'Memory',
  cpuTotal: 'CPU',
  memFragmentation: 'Fragmentation',
};

export function MetricForecasting() {
  const { currentConnection } = useConnection();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const saveTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const debounceTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const connectionId = currentConnection?.id;
  const tabParam = searchParams.get('tab');
  const activeTab: MetricKind =
    tabParam && ALL_METRIC_KINDS.includes(tabParam as MetricKind)
      ? (tabParam as MetricKind)
      : 'opsPerSec';

  const setActiveTab = useCallback(
    (tab: MetricKind) => {
      setSearchParams({ tab }, { replace: true });
    },
    [setSearchParams],
  );

  const meta = METRIC_KIND_META[activeTab];

  const { data: forecast } = useQuery({
    queryKey: ['metric-forecast', connectionId, activeTab],
    queryFn: ({ signal }) => metricForecastingApi.getForecast(activeTab, signal),
    enabled: !!connectionId,
    refetchInterval: 30_000,
  });

  const { data: settings } = useQuery({
    queryKey: ['metric-forecast-settings', connectionId, activeTab],
    queryFn: ({ signal }) => metricForecastingApi.getSettings(activeTab, signal),
    enabled: !!connectionId,
  });

  const { data: chartData = [] } = useQuery({
    queryKey: ['metric-forecast-chart', connectionId, activeTab, settings?.rollingWindowMs],
    queryFn: async () => {
      const now = Date.now();
      const snapshots = await metricsApi.getStoredMemorySnapshots({
        startTime: now - settings!.rollingWindowMs,
        limit: 1500,
      });
      const extractor = METRIC_EXTRACTORS[activeTab];
      return [...snapshots]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((s) => ({ time: s.timestamp, value: extractor(s), label: formatTime(s.timestamp) }));
    },
    enabled: !!connectionId && !!settings,
    refetchInterval: 30_000,
  });

  const updateSetting = (updates: MetricForecastSettingsUpdate) => {
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);

    queryClient.setQueryData(
      ['metric-forecast-settings', connectionId, activeTab],
      (prev: typeof settings) => (prev ? { ...prev, ...updates, updatedAt: Date.now() } : prev),
    );

    debounceTimeout.current = setTimeout(async () => {
      try {
        const updated = await metricForecastingApi.updateSettings(activeTab, updates);
        queryClient.setQueryData(['metric-forecast-settings', connectionId, activeTab], updated);
        setSaveStatus('saved');
        await queryClient.invalidateQueries({
          queryKey: ['metric-forecast', connectionId, activeTab],
        });
        if (saveTimeout.current) clearTimeout(saveTimeout.current);
        saveTimeout.current = setTimeout(() => setSaveStatus('idle'), 2000);
      } catch {
        await queryClient.invalidateQueries({
          queryKey: ['metric-forecast-settings', connectionId, activeTab],
        });
        setSaveStatus('error');
      }
    }, 500);
  };

  if (!forecast || !settings) return <MetricLoading />;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Metric Forecasting</h1>

      {/* Tab bar */}
      <div className="flex border-b">
        {ALL_METRIC_KINDS.map((kind) => (
          <button
            key={kind}
            onClick={() => setActiveTab(kind)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === kind
                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-gray-300'
            }`}
          >
            {TAB_LABELS[kind]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {!forecast.enabled ? (
        <MetricDisabled meta={meta} />
      ) : forecast.insufficientData ? (
        <MetricInsufficientData forecast={forecast} meta={meta} />
      ) : (
        <>
          <MetricForecastCard forecast={forecast} meta={meta} />
          <MetricChart chartData={chartData} forecast={forecast} settings={settings} meta={meta} />
        </>
      )}

      <MetricSettingsPanel
        settings={settings}
        meta={meta}
        onUpdate={updateSetting}
        saveStatus={saveStatus}
      />
    </div>
  );
}
