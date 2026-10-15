import { READINESS_DIMENSION_LABELS, type ScalingReadinessHistoryPoint } from '@betterdb/shared';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format } from 'date-fns';
import { formatTime } from '../metric-forecasting/formatters';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_MS = 3 * DAY_MS;

export type ReadinessSpan = 'time' | 'dateTime' | 'date';

export function readinessSpan(points: { timestamp: number }[]): ReadinessSpan {
  if (points.length < 2) return 'time';
  const first = points[0].timestamp;
  const last = points[points.length - 1].timestamp;
  if (last - first > DATE_ONLY_MS) return 'date';
  if (last - first > DAY_MS || new Date(first).toDateString() !== new Date(last).toDateString()) {
    return 'dateTime';
  }
  return 'time';
}

export function formatReadinessAxisLabel(timestamp: number, span: ReadinessSpan): string {
  if (span === 'date') return format(timestamp, 'MMM d');
  if (span === 'dateTime') return format(timestamp, 'MMM d HH:mm');
  return formatTime(timestamp);
}

export function formatReadinessTooltipLabel(timestamp: number, span: ReadinessSpan): string {
  return span === 'time' ? formatTime(timestamp) : format(timestamp, 'MMM d, HH:mm');
}

export function ReadinessHistoryChart({ points }: { points: ScalingReadinessHistoryPoint[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-muted-foreground">No score history in this range yet.</p>;
  }
  const span = readinessSpan(points);
  const data = points.map((p) => ({ ...p, label: formatReadinessTooltipLabel(p.timestamp, span) }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="timestamp"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(value: number) => formatReadinessAxisLabel(value, span)}
          minTickGap={40}
        />
        <YAxis domain={[0, 100]} />
        <ReferenceLine y={70} strokeDasharray="4 4" stroke="var(--color-green-500, #22c55e)" />
        <ReferenceLine y={40} strokeDasharray="4 4" stroke="var(--color-red-500, #ef4444)" />
        <Tooltip
          formatter={(value) => [value, 'Score']}
          labelFormatter={(_label, payload) => {
            const point = payload?.[0]?.payload as (typeof data)[number] | undefined;
            if (!point) return '';
            const binding = point.bindingDimension
              ? ` · ${READINESS_DIMENSION_LABELS[point.bindingDimension]}`
              : '';
            return `${point.label}${binding}`;
          }}
        />
        <Area type="monotone" dataKey="score" stroke="#6366f1" fill="#6366f1" fillOpacity={0.2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
