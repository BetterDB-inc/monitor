import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { InferenceLatencyTrend } from '@betterdb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { formatDurationUs } from '../../lib/utils';

interface Props {
  trend: InferenceLatencyTrend;
  healthyThresholdUs?: number | null;
  indexingBands?: Array<{ start: number; end: number }>;
  height?: number;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function InferenceTrendChart({
  trend,
  healthyThresholdUs,
  indexingBands,
  height = 200,
}: Props) {
  const hasData = trend.points.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-mono">
          Trend — <span className="text-muted-foreground font-normal">{trend.bucket}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="text-sm text-muted-foreground">
            No samples in the selected range.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <LineChart data={trend.points}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="capturedAt"
                tickFormatter={formatTime}
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10 }}
                width={60}
                tickFormatter={(v) => formatDurationUs(Number(v))}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--popover)',
                  borderColor: 'var(--border)',
                  borderRadius: 8,
                  color: 'var(--popover-foreground)',
                }}
                labelStyle={{ color: 'var(--muted-foreground)' }}
                itemStyle={{ color: 'var(--popover-foreground)' }}
                labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                formatter={(value, name) => [formatDurationUs(Number(value)), name]}
              />
              {indexingBands?.map((band, i) => (
                <ReferenceArea
                  key={`band-${i}`}
                  x1={band.start}
                  x2={band.end}
                  strokeOpacity={0}
                  fill="var(--chart-warning)"
                  fillOpacity={0.18}
                />
              ))}
              {healthyThresholdUs != null && (
                <ReferenceLine
                  y={healthyThresholdUs}
                  stroke="var(--chart-critical)"
                  strokeDasharray="4 4"
                  strokeOpacity={0.7}
                />
              )}
              <Line
                type="monotone"
                dataKey="p50"
                stroke="var(--chart-info)"
                strokeWidth={1.5}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="p95"
                stroke="var(--chart-warning)"
                strokeWidth={1.5}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="p99"
                stroke="var(--chart-critical)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
