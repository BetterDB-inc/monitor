import type {
  KvCacheEngine,
  KvCacheFootprintSnapshot,
  KvCacheSampleBucket,
} from '@betterdb/shared';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatBytes } from '../../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { chartTimeFormatter, formatPercent } from './kv-cache-format';

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899'];

interface Props {
  buckets: KvCacheSampleBucket[];
  bucketMs?: number;
  history: KvCacheFootprintSnapshot[];
  engines: KvCacheEngine[];
}

type Row = { timestamp: number } & Record<string, number | null>;

function timeAxis(formatTime: (timestamp: number) => string) {
  return (
    <XAxis
      dataKey="timestamp"
      type="number"
      scale="time"
      domain={['dataMin', 'dataMax']}
      tickFormatter={(value: number) => formatTime(value)}
      minTickGap={40}
    />
  );
}

function timeSpan(points: Array<{ timestamp: number }>): number {
  if (points.length === 0) return 0;
  let first = points[0].timestamp;
  let last = first;
  for (const point of points) {
    first = Math.min(first, point.timestamp);
    last = Math.max(last, point.timestamp);
  }
  return last - first;
}

function rowsByTimestamp(rows: Map<number, Row>): Row[] {
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function hitRateRows(buckets: KvCacheSampleBucket[], engineNames: Map<string, string>) {
  const series = new Map<string, string>();
  const rows = new Map<number, Row>();
  for (const bucket of buckets) {
    if (bucket.hitRate === null) continue;
    const key = `${bucket.engineId}|${bucket.modelName}`;
    series.set(key, `${engineNames.get(bucket.engineId) ?? bucket.engineId} | ${bucket.modelName}`);
    const row = rows.get(bucket.timestamp) ?? { timestamp: bucket.timestamp };
    row[key] = bucket.hitRate;
    rows.set(bucket.timestamp, row);
  }
  return {
    series: [...series].map(([key, label]) => ({ key, label })),
    rows: rowsByTimestamp(rows),
  };
}

const MINUTE_MS = 60_000;

export function remoteBytesPerMinute(buckets: KvCacheSampleBucket[], bucketMs: number): Row[] {
  const minutes = Math.max(1, bucketMs / MINUTE_MS);
  const rows = new Map<number, Row>();
  for (const bucket of buckets) {
    const row = rows.get(bucket.timestamp) ?? { timestamp: bucket.timestamp, read: 0, write: 0 };
    row.read = (row.read ?? 0) + bucket.remoteReadBytes / minutes;
    row.write = (row.write ?? 0) + bucket.remoteWriteBytes / minutes;
    rows.set(bucket.timestamp, row);
  }
  return rowsByTimestamp(rows);
}

function footprintRows(history: KvCacheFootprintSnapshot[]) {
  const series = new Set<string>();
  const rows: Row[] = history.map((snapshot) => {
    const row: Row = { timestamp: snapshot.timestamp };
    for (const entry of snapshot.perModel) {
      series.add(entry.model);
      const sum = row[entry.model];
      row[entry.model] = sum === null || entry.bytesEst === null ? null : (sum ?? 0) + entry.bytesEst;
    }
    return row;
  });
  for (const row of rows) {
    for (const model of series) if (row[model] === undefined) row[model] = 0;
  }
  return { series: [...series], rows };
}

function ChartCard({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground">No data in this range yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            {children as React.ReactElement}
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function KvCacheCharts({ buckets, bucketMs = MINUTE_MS, history, engines }: Props) {
  const engineNames = new Map(engines.map((engine) => [engine.id, engine.name]));
  const hitRate = hitRateRows(buckets, engineNames);
  const remote = remoteBytesPerMinute(buckets, bucketMs);
  const footprint = footprintRows(history);
  const formatTime = chartTimeFormatter(timeSpan([...buckets, ...history]));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard title="Hit rate per engine and model" empty={hitRate.rows.length === 0}>
        <LineChart data={hitRate.rows}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          {timeAxis(formatTime)}
          <YAxis domain={[0, 1]} tickFormatter={(value: number) => formatPercent(value)} />
          <Tooltip
            labelFormatter={(label) => formatTime(Number(label))}
            formatter={(value) => formatPercent(Number(value))}
          />
          <Legend />
          {hitRate.series.map(({ key, label }, index) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              name={label}
              stroke={COLORS[index % COLORS.length]}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartCard>
      <ChartCard title="Remote read and write bytes per minute" empty={remote.length === 0}>
        <LineChart data={remote}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          {timeAxis(formatTime)}
          <YAxis tickFormatter={(value: number) => formatBytes(value)} width={80} />
          <Tooltip
            labelFormatter={(label) => formatTime(Number(label))}
            formatter={(value) => formatBytes(Number(value))}
          />
          <Legend />
          <Line
            type="monotone"
            dataKey="read"
            name="Read"
            stroke={COLORS[0]}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="write"
            name="Write"
            stroke={COLORS[1]}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartCard>
      <div className="lg:col-span-2">
        <ChartCard title="Footprint per model" empty={footprint.rows.length === 0}>
          <AreaChart data={footprint.rows}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            {timeAxis(formatTime)}
            <YAxis tickFormatter={(value: number) => formatBytes(value)} width={80} />
            <Tooltip
              labelFormatter={(label) => formatTime(Number(label))}
              formatter={(value) => formatBytes(Number(value))}
            />
            <Legend />
            {footprint.series.map((model, index) => (
              <Area
                key={model}
                type="monotone"
                dataKey={model}
                stackId="footprint"
                stroke={COLORS[index % COLORS.length]}
                fill={COLORS[index % COLORS.length]}
                fillOpacity={0.3}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ChartCard>
      </div>
    </div>
  );
}
