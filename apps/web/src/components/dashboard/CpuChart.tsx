import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

interface Props {
  data: Array<{ time: string; sys: number; user: number }>;
}

export function CpuChart({ data }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Server CPU Utilization (%)</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data}>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 12 }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickLine={false}
              tickFormatter={(value) => `${value.toFixed(1)}%`}
            />
            <Tooltip
              formatter={(value) => {
                const num = typeof value === 'number' ? value : 0;
                return [`${num.toFixed(1)}%`];
              }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="sys"
              name="System"
              stroke="#ef4444"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="user"
              name="User"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
