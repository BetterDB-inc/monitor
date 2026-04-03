import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface Props {
  data: Array<{ time: string; used: number; peak: number }>;
}

export function MemoryChart({ data }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory Usage</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data}>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 12 }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickLine={false}
              tickFormatter={(value) => `${(value / 1024 / 1024).toFixed(0)}MB`}
            />
            <Tooltip
              formatter={(value) => {
                const num = typeof value === 'number' ? value : 0;
                return [`${(num / 1024 / 1024).toFixed(2)} MB`];
              }}
            />
            <Area
              type="monotone"
              dataKey="used"
              stroke="var(--chart-1)"
              fill="var(--chart-1)"
              fillOpacity={0.3}
              name="Used"
            />
            <Area
              type="monotone"
              dataKey="peak"
              stroke="var(--chart-2)"
              fill="var(--chart-2)"
              fillOpacity={0.1}
              name="Peak"
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
