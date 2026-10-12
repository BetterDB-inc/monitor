import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { HEADROOM, type Projection } from '@betterdb/shared';
import { formatBytes } from '../../../lib/utils';

interface Props {
  projection: Projection;
  maxmemory: number | null;
}

export function ProjectionChart({ projection, maxmemory }: Props) {
  const data = projection.points.map((point) => ({ ...point, band: [point.low, point.high] }));
  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data}>
        <XAxis dataKey="day" tickFormatter={(day: number) => `${day}d`} />
        <YAxis tickFormatter={(bytes: number) => formatBytes(bytes)} width={90} />
        <Tooltip formatter={(value) => (Array.isArray(value) ? value.map((entry) => formatBytes(Number(entry))).join(' – ') : formatBytes(Number(value ?? 0)))} labelFormatter={(day) => `Day ${day}`} />
        <Area dataKey="band" name="95% range" stroke="none" fill="var(--chart-1)" fillOpacity={0.15} isAnimationActive={false} />
        <Line dataKey="bytes" name="Projected size" stroke="var(--chart-1)" dot={false} isAnimationActive={false} />
        {maxmemory && <ReferenceLine y={maxmemory} stroke="var(--destructive)" label="maxmemory" />}
        {maxmemory && <ReferenceLine y={maxmemory * HEADROOM} stroke="var(--muted-foreground)" strokeDasharray="4 4" label="80%" />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
