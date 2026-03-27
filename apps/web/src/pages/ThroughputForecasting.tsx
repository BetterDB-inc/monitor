import { useState, useEffect, useCallback, useRef } from 'react';
import { useConnection } from '../hooks/useConnection';
import { usePolling } from '../hooks/usePolling';
import { metricsApi } from '../api/metrics';
import { Card } from '../components/ui/card';
import type { ThroughputForecast, ThroughputSettings, ThroughputSettingsUpdate } from '../types/throughput';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

const WINDOW_PRESETS = [
  { label: '1h', value: 3600000 },
  { label: '3h', value: 10800000 },
  { label: '6h', value: 21600000 },
  { label: '12h', value: 43200000 },
  { label: '24h', value: 86400000 },
];

const ALERT_PRESETS = [
  { label: '30m', value: 1800000 },
  { label: '1h', value: 3600000 },
  { label: '2h', value: 7200000 },
  { label: '4h', value: 14400000 },
];

function formatOps(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

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
    metricsApi.getThroughputSettings().then(setSettings).catch(() => {});
  }, [currentConnection?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chart data
  const [chartData, setChartData] = useState<Array<{ time: number; ops: number; label: string }>>([]);
  useEffect(() => {
    if (!settings) return;
    const now = Date.now();
    metricsApi
      .getStoredMemorySnapshots({ startTime: now - settings.rollingWindowMs, limit: 1500 })
      .then((snapshots) => {
        const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
        setChartData(sorted.map((s) => ({ time: s.timestamp, ops: s.opsPerSec, label: formatTime(s.timestamp) })));
      })
      .catch(() => {});
  }, [settings?.rollingWindowMs, currentConnection?.id, forecast]);

  const updateSetting = useCallback(
    (updates: ThroughputSettingsUpdate) => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
      setSettings((prev: ThroughputSettings | null) => (prev ? { ...prev, ...updates, updatedAt: Date.now() } : prev));

      debounceTimeout.current = setTimeout(async () => {
        try {
          const updated = await metricsApi.updateThroughputSettings(updates);
          setSettings(updated);
          setSaveStatus('saved');
          refreshForecast();
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
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Throughput Forecast</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!forecast.enabled) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Throughput Forecast</h1>
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground">Throughput forecasting is disabled for this connection.</p>
            <button
              onClick={() => updateSetting({ enabled: true })}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Enable
            </button>
          </div>
        </Card>
        <SettingsPanel settings={settings} onUpdate={updateSetting} saveStatus={saveStatus} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Throughput Forecast</h1>

      <SettingsPanel settings={settings} onUpdate={updateSetting} saveStatus={saveStatus} />

      {forecast.insufficientData ? (
        <Card className="p-6">
          <p className="text-muted-foreground">{forecast.insufficientDataMessage}</p>
          {forecast.currentOpsPerSec > 0 && (
            <p className="mt-2 text-2xl font-semibold">{formatOps(forecast.currentOpsPerSec)} ops/sec</p>
          )}
        </Card>
      ) : (
        <>
          <ForecastCard forecast={forecast} />
          <ThroughputChart chartData={chartData} forecast={forecast} settings={settings} />
        </>
      )}
    </div>
  );
}

// ── Settings Panel ──

function SettingsPanel({
  settings,
  onUpdate,
  saveStatus,
}: {
  settings: ThroughputSettings;
  onUpdate: (u: ThroughputSettingsUpdate) => void;
  saveStatus: 'idle' | 'saved' | 'error';
}) {
  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="flex items-center gap-2">
          {saveStatus === 'saved' && <span className="text-sm text-green-600">Saved</span>}
          {saveStatus === 'error' && <span className="text-sm text-red-600">Error saving</span>}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Rolling Window</label>
          <select
            value={settings.rollingWindowMs}
            onChange={(e) => onUpdate({ rollingWindowMs: parseInt(e.target.value) })}
            className="w-full px-3 py-2 border rounded-md"
          >
            {WINDOW_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Ops/sec Ceiling</label>
          <input
            type="number"
            value={settings.opsCeiling ?? ''}
            placeholder="No ceiling"
            onChange={(e) => onUpdate({ opsCeiling: e.target.value ? parseInt(e.target.value) : null })}
            className="w-full px-3 py-2 border rounded-md"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Alert Threshold <span className="text-xs text-muted-foreground">(Pro)</span>
          </label>
          <select
            value={settings.alertThresholdMs}
            onChange={(e) => onUpdate({ alertThresholdMs: parseInt(e.target.value) })}
            className="w-full px-3 py-2 border rounded-md"
            disabled={settings.opsCeiling === null}
          >
            {ALERT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Card>
  );
}

// ── Forecast Card ──

function ForecastCard({ forecast }: { forecast: ThroughputForecast }) {
  const directionArrow = forecast.trendDirection === 'rising' ? '\u2197' : forecast.trendDirection === 'falling' ? '\u2198' : '\u2192';

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-3">
        {forecast.mode === 'forecast' ? 'Throughput Forecast' : 'Throughput Trend'}
      </h2>

      {forecast.mode === 'forecast' && forecast.timeToLimitHuman && (
        <p className="text-2xl font-bold mb-4">{forecast.timeToLimitHuman}</p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <p className="text-muted-foreground">Current</p>
          <p className="font-semibold">{formatOps(forecast.currentOpsPerSec)} ops/sec</p>
        </div>
        {forecast.opsCeiling && (
          <div>
            <p className="text-muted-foreground">Ceiling</p>
            <p className="font-semibold">{formatOps(forecast.opsCeiling)} ops/sec</p>
          </div>
        )}
        <div>
          <p className="text-muted-foreground">Growth Rate</p>
          <p className="font-semibold">{forecast.growthRate >= 0 ? '+' : ''}{formatOps(Math.round(forecast.growthRate))}/hr</p>
        </div>
        <div>
          <p className="text-muted-foreground">Trend</p>
          <p className="font-semibold">
            {directionArrow} {forecast.trendDirection} ({forecast.growthPercent >= 0 ? '+' : ''}{forecast.growthPercent.toFixed(1)}%)
          </p>
        </div>
      </div>
    </Card>
  );
}

// ── Chart ──

function ThroughputChart({
  chartData,
  forecast,
  settings,
}: {
  chartData: Array<{ time: number; ops: number; label: string }>;
  forecast: ThroughputForecast;
  settings: ThroughputSettings;
}) {
  if (chartData.length === 0) return null;

  // Build trend line data
  const trendData: Array<{ time: number; trend: number; label: string }> = [];
  if (chartData.length >= 2 && forecast.growthRate !== 0) {
    const firstTime = chartData[0].time;
    const lastTime = chartData[chartData.length - 1].time;
    const now = Date.now();
    // Extend forward: to ceiling or 2x window, whichever is sooner
    const extendMs = settings.opsCeiling !== null && forecast.timeToLimitMs !== null && forecast.timeToLimitMs > 0
      ? Math.min(forecast.timeToLimitMs, settings.rollingWindowMs)
      : settings.rollingWindowMs;
    const endTime = now + extendMs;

    // Use regression to compute trend values
    const slopePerMs = forecast.growthRate / 3_600_000;
    const lastOps = chartData[chartData.length - 1].ops;
    const intercept = lastOps - slopePerMs * lastTime;

    // Historical portion of trend
    trendData.push({ time: firstTime, trend: slopePerMs * firstTime + intercept, label: formatTime(firstTime) });
    trendData.push({ time: lastTime, trend: slopePerMs * lastTime + intercept, label: formatTime(lastTime) });
    // Projected portion
    if (endTime > lastTime) {
      trendData.push({ time: endTime, trend: slopePerMs * endTime + intercept, label: formatTime(endTime) });
    }
  }

  // Merge for common x-axis
  const allTimes = new Set([...chartData.map((d) => d.time), ...trendData.map((d) => d.time)]);
  const merged = [...allTimes]
    .sort((a, b) => a - b)
    .map((t) => {
      const dataPoint = chartData.find((d) => d.time === t);
      const trendPoint = trendData.find((d) => d.time === t);
      return {
        time: t,
        label: formatTime(t),
        ops: dataPoint?.ops ?? undefined,
        trend: trendPoint?.trend ?? undefined,
      };
    });

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-3">Ops/sec History</h2>
      <ResponsiveContainer width="100%" height={350}>
        <LineChart data={merged}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            interval="preserveStartEnd"
          />
          <YAxis tickFormatter={formatOps} tick={{ fontSize: 11 }} />
          <Tooltip
            formatter={(value) => [formatOps(Number(value)), '']}
            labelFormatter={(label) => String(label)}
          />
          <Line
            type="monotone"
            dataKey="ops"
            stroke="#6366f1"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            name="Ops/sec"
          />
          <Line
            type="linear"
            dataKey="trend"
            stroke="#f59e0b"
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            connectNulls
            name="Trend"
          />
          {settings.opsCeiling !== null && (
            <ReferenceLine
              y={settings.opsCeiling}
              stroke="#ef4444"
              strokeDasharray="8 4"
              label={{ value: `Ceiling: ${formatOps(settings.opsCeiling)}`, position: 'right', fontSize: 11, fill: '#ef4444' }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}
