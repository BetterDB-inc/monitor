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
import { formatTime } from '../metric-forecasting/formatters';

export function ReadinessHistoryChart({ points }: { points: ScalingReadinessHistoryPoint[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-muted-foreground">No score history in this range yet.</p>;
  }
  const data = points.map((p) => ({ ...p, label: formatTime(p.timestamp) }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis dataKey="label" minTickGap={40} />
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
