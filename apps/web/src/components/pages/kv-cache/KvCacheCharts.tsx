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
import { formatTime } from '../metric-forecasting/formatters';
import { formatPercent } from './kv-cache-format';

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899'];

interface Props {
  buckets: KvCacheSampleBucket[];
  history: KvCacheFootprintSnapshot[];
  engines: KvCacheEngine[];
}

type Row = { timestamp: number } & Record<string, number | null>;

function timeAxis() {
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

function rowsByTimestamp(rows: Map<number, Row>): Row[] {
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function hitRateRows(buckets: KvCacheSampleBucket[], engineNames: Map<string, string>) {
  const series = new Set<string>();
  const rows = new Map<number, Row>();
  for (const bucket of buckets) {
    if (bucket.hitRate === null) continue;
    const name = `${engineNames.get(bucket.engineId) ?? bucket.engineId} | ${bucket.modelName}`;
    series.add(name);
    const row = rows.get(bucket.timestamp) ?? { timestamp: bucket.timestamp };
    row[name] = bucket.hitRate;
    rows.set(bucket.timestamp, row);
  }
  return { series: [...series], rows: rowsByTimestamp(rows) };
}

function remoteBytesRows(buckets: KvCacheSampleBucket[]) {
  const rows = new Map<number, Row>();
  for (const bucket of buckets) {
    const row = rows.get(bucket.timestamp) ?? { timestamp: bucket.timestamp, read: 0, write: 0 };
    row.read = (row.read ?? 0) + bucket.remoteReadBytes;
    row.write = (row.write ?? 0) + bucket.remoteWriteBytes;
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
      row[entry.model] = (row[entry.model] ?? 0) + entry.bytesEst;
    }
    return row;
  });
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

export function KvCacheCharts({ buckets, history, engines }: Props) {
  const engineNames = new Map(engines.map((engine) => [engine.id, engine.name]));
  const hitRate = hitRateRows(buckets, engineNames);
  const remote = remoteBytesRows(buckets);
  const footprint = footprintRows(history);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard title="Hit rate per engine and model" empty={hitRate.rows.length === 0}>
        <LineChart data={hitRate.rows}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          {timeAxis()}
          <YAxis domain={[0, 1]} tickFormatter={(value: number) => formatPercent(value)} />
          <Tooltip
            labelFormatter={(label) => formatTime(Number(label))}
            formatter={(value) => formatPercent(Number(value))}
          />
          <Legend />
          {hitRate.series.map((name, index) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
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
          {timeAxis()}
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
            {timeAxis()}
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
