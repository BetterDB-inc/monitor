import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Cpu } from 'lucide-react';
import { shouldShowIoChart } from './io-threads.utils';

interface Props {
  data: Array<{ time: string; reads: number; writes: number }>;
  isMultiThreaded: boolean;
  hasEverSeenActivity: boolean;
}

export function IoThreadChart({ data, isMultiThreaded, hasEverSeenActivity }: Props) {
  const showChart = shouldShowIoChart(isMultiThreaded, hasEverSeenActivity, data);

  if (!showChart) {
    return (
      <Card className="min-h-[360px]">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>I/O Thread Activity</CardTitle>
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              Single-threaded
            </span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col items-center justify-center gap-3 text-center flex-1">
          <Cpu className="w-10 h-10 text-muted-foreground" />
          <p className="font-medium">Single-threaded I/O</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            All reads and writes are handled by the main thread. On multi-core machines with high
            connection counts, enabling I/O threads can reduce latency under load.
          </p>
          <code className="bg-muted rounded px-2 py-1 text-xs font-mono">
            io-threads 4<br />
            io-threads-do-reads yes
          </code>
          <p className="text-xs text-muted-foreground">
            Restart required. Recommended only if you're seeing main-thread CPU saturation.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>I/O Thread Activity</CardTitle>
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
            Multi-threaded
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex items-center justify-center text-muted-foreground" style={{ height: 300 }}>
            Waiting for data...
          </div>
        ) : (
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
              />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="reads"
                stroke="var(--chart-1)"
                fill="var(--chart-1)"
                fillOpacity={0.3}
                name="Reads/s"
              />
              <Area
                type="monotone"
                dataKey="writes"
                stroke="var(--chart-2)"
                fill="var(--chart-2)"
                fillOpacity={0.1}
                name="Writes/s"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
