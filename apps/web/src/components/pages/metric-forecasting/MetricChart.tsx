import type { MetricForecast, MetricForecastSettings, MetricKindMeta } from '@betterdb/shared';
import { useMemo } from 'react';
import { formatMetricValue, formatTime } from './formatters';
import { Card } from '../../ui/card';
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

interface ChartDataPoint {
  time: number;
  value: number;
  label: string;
}

export function MetricChart({
  chartData,
  forecast,
  settings,
  meta,
}: {
  chartData: ChartDataPoint[];
  forecast: MetricForecast;
  settings: MetricForecastSettings;
  meta: MetricKindMeta;
}) {
  const fmt = (v: number) => formatMetricValue(v, meta.valueFormatter);

  const merged = useMemo(() => {
    const trendData: Array<{ time: number; trend: number; label: string }> = [];
    if (chartData.length >= 2 && forecast.growthRate !== 0) {
      const firstTime = chartData[0].time;
      const lastTime = chartData[chartData.length - 1].time;
      const now = Date.now();
      const extendMs =
        forecast.ceiling !== null &&
        forecast.timeToLimitMs !== null &&
        forecast.timeToLimitMs > 0
          ? Math.min(forecast.timeToLimitMs, settings.rollingWindowMs)
          : settings.rollingWindowMs;
      const endTime = now + extendMs;

      const slopePerMs = forecast.growthRate / 3_600_000;
      const lastVal = chartData[chartData.length - 1].value;
      const intercept = lastVal - slopePerMs * lastTime;

      const trendAt = (t: number) => Math.max(0, slopePerMs * t + intercept);
      trendData.push({ time: firstTime, trend: trendAt(firstTime), label: formatTime(firstTime) });
      trendData.push({ time: lastTime, trend: trendAt(lastTime), label: formatTime(lastTime) });
      if (endTime > lastTime) {
        trendData.push({ time: endTime, trend: trendAt(endTime), label: formatTime(endTime) });
      }
    }

    const chartDataByTime = new Map(chartData.map((d) => [d.time, d]));
    const trendDataByTime = new Map(trendData.map((d) => [d.time, d]));

    const allTimes = new Set([...chartData.map((d) => d.time), ...trendData.map((d) => d.time)]);
    return [...allTimes]
      .sort((a, b) => a - b)
      .map((t) => {
        const dp = chartDataByTime.get(t);
        const tp = trendDataByTime.get(t);
        return {
          time: t,
          label: formatTime(t),
          value: dp?.value ?? undefined,
          trend: tp?.trend ?? undefined,
        };
      });
  }, [chartData, forecast.growthRate, forecast.timeToLimitMs, forecast.ceiling, settings.rollingWindowMs]);

  if (chartData.length === 0) return null;

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-3">{meta.label} History</h2>
      <ResponsiveContainer width="100%" height={350}>
        <LineChart data={merged}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis tickFormatter={fmt} tick={{ fontSize: 11 }} />
          <Tooltip
            formatter={(value) => [fmt(Number(value)), '']}
            labelFormatter={(label) => String(label)}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#6366f1"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            name={meta.label}
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
          {forecast.ceiling !== null && (
            <ReferenceLine
              y={forecast.ceiling}
              stroke="#ef4444"
              strokeDasharray="8 4"
              label={{
                value: `Ceiling: ${fmt(forecast.ceiling)}`,
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
