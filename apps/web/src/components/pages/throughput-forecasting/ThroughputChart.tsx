import { ThroughputForecast, ThroughputSettings } from '@betterdb/shared';
import { useMemo } from 'react';
import { formatOps, formatTime } from './utils.ts';
import { Card } from '../../ui/card.tsx';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export function ThroughputChart({
  chartData,
  forecast,
  settings,
}: {
  chartData: Array<{ time: number; ops: number; label: string }>;
  forecast: ThroughputForecast;
  settings: ThroughputSettings;
}) {
  const merged = useMemo(() => {
    // Build trend line data
    const trendData: Array<{ time: number; trend: number; label: string }> = [];
    if (chartData.length >= 2 && forecast.growthRate !== 0) {
      const firstTime = chartData[0].time;
      const lastTime = chartData[chartData.length - 1].time;
      const now = Date.now();
      // Extend forward: to ceiling or 2x window, whichever is sooner
      const extendMs =
        settings.opsCeiling !== null &&
        forecast.timeToLimitMs !== null &&
        forecast.timeToLimitMs > 0
          ? Math.min(forecast.timeToLimitMs, settings.rollingWindowMs)
          : settings.rollingWindowMs;
      const endTime = now + extendMs;

      // Use regression to compute trend values
      const slopePerMs = forecast.growthRate / 3_600_000;
      const lastOps = chartData[chartData.length - 1].ops;
      const intercept = lastOps - slopePerMs * lastTime;

      // Historical portion of trend
      trendData.push({
        time: firstTime,
        trend: slopePerMs * firstTime + intercept,
        label: formatTime(firstTime),
      });
      trendData.push({
        time: lastTime,
        trend: slopePerMs * lastTime + intercept,
        label: formatTime(lastTime),
      });
      // Projected portion
      if (endTime > lastTime) {
        trendData.push({
          time: endTime,
          trend: slopePerMs * endTime + intercept,
          label: formatTime(endTime),
        });
      }
    }

    // Merge for common x-axis
    const allTimes = new Set([...chartData.map((d) => d.time), ...trendData.map((d) => d.time)]);
    return [...allTimes]
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
  }, [
    chartData,
    forecast.growthRate,
    forecast.timeToLimitMs,
    settings.opsCeiling,
    settings.rollingWindowMs,
  ]);

  if (chartData.length === 0) {
    return null;
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-3">Ops/sec History</h2>
      <ResponsiveContainer width="100%" height={350}>
        <LineChart data={merged}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
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
              label={{
                value: `Ceiling: ${formatOps(settings.opsCeiling)}`,
                position: 'right',
                fontSize: 11,
                fill: '#ef4444',
              }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}
