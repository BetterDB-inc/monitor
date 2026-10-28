import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { HEADROOM, type Projection } from '@betterdb/shared';
import { formatBytes } from '../../../lib/utils';
import { byteTicks, dayAxis } from './chart-ticks';

interface Props {
  projection: Projection;
  maxmemory: number | null;
}

export function ProjectionChart({ projection, maxmemory }: Props) {
  const data = projection.points.map((point) => ({ ...point, band: [point.low, point.high] }));
  const hasRange = projection.points.some((point) => point.high > point.low);
  const yTicks = byteTicks(Math.max(maxmemory ?? 0, ...projection.points.map((point) => point.high)));
  const xAxis = dayAxis(projection.points[projection.points.length - 1].day);
  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data}>
        <XAxis dataKey="day" type="number" domain={xAxis.domain} ticks={xAxis.ticks} tickFormatter={(day: number) => `${day}d`} />
        <YAxis domain={[0, yTicks[yTicks.length - 1]]} ticks={yTicks} tickFormatter={(bytes: number) => formatBytes(bytes)} width={90} />
        <Tooltip
          contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--popover-foreground)' }}
          labelStyle={{ color: 'var(--muted-foreground)' }}
          itemStyle={{ color: 'var(--popover-foreground)' }}
          formatter={(value) => (Array.isArray(value) ? value.map((entry) => formatBytes(Number(entry))).join(' – ') : formatBytes(Number(value ?? 0)))} labelFormatter={(day) => `Day ${day}`} />
        {hasRange && <Area dataKey="band" name="95% range" stroke="none" fill="var(--chart-1)" fillOpacity={0.15} isAnimationActive={false} />}
        <Line dataKey="bytes" name="Projected size" stroke="var(--chart-1)" dot={false} isAnimationActive={false} />
        {maxmemory && <ReferenceLine y={maxmemory} stroke="var(--destructive)" label={{ value: 'maxmemory', position: 'insideTopRight' }} ifOverflow="extendDomain" />}
        {maxmemory && <ReferenceLine y={maxmemory * HEADROOM} stroke="var(--muted-foreground)" strokeDasharray="4 4" label={{ value: '80%', position: 'insideBottomRight' }} ifOverflow="extendDomain" />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
