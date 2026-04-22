import { useMemo, useState } from 'react';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import type { VectorIndexInfo } from '../types/metrics';
import { metricsApi } from '../api/metrics';
import {
  getCommandStatsHistory,
  toChartSeries,
  type CommandStatsChartPoint,
} from '../api/commandstats';
import { useCapabilities } from '../hooks/useCapabilities';
import { useConnection } from '../hooks/useConnection';
import { usePolling } from '../hooks/usePolling';
import { UnavailableOverlay } from '../components/UnavailableOverlay';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { DateRangePicker, type DateRange } from '../components/ui/date-range-picker';

const INDEX_POLL_MS = 30_000;
const COMMANDSTATS_POLL_MS = 15_000;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

interface HealthAlert {
  indexName: string;
  kind: 'failures' | 'backfilling' | 'deletions';
  message: string;
}

function deriveAlerts(indexes: VectorIndexInfo[]): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  for (const idx of indexes) {
    if (idx.indexingFailures > 0) {
      alerts.push({
        indexName: idx.name,
        kind: 'failures',
        message: `${idx.indexingFailures} hash indexing failure${idx.indexingFailures === 1 ? '' : 's'}`,
      });
    }
    if (idx.percentIndexed < 100 && idx.indexingState !== 'indexed') {
      alerts.push({
        indexName: idx.name,
        kind: 'backfilling',
        message: `Backfilling — ${idx.percentIndexed.toFixed(1)}% indexed`,
      });
    }
    if (idx.numDeletedDocs > 0) {
      alerts.push({
        indexName: idx.name,
        kind: 'deletions',
        message: `${idx.numDeletedDocs.toLocaleString()} deleted docs accumulating`,
      });
    }
  }
  return alerts;
}

function formatTick(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function VectorAi() {
  const { hasVectorSearch } = useCapabilities();
  const { currentConnection } = useConnection();
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  const indexListQuery = usePolling({
    fetcher: (signal) => metricsApi.getVectorIndexList(signal),
    interval: INDEX_POLL_MS,
    enabled: hasVectorSearch,
    refetchKey: currentConnection?.id,
  });

  const indexNames = indexListQuery.data?.indexes ?? [];

  const indexInfoQuery = usePolling({
    fetcher: async () => {
      const infos = await Promise.all(
        indexNames.map((name) => metricsApi.getVectorIndexInfo(name).catch(() => null)),
      );
      return infos.filter((v): v is VectorIndexInfo => v !== null);
    },
    interval: INDEX_POLL_MS,
    enabled: hasVectorSearch && indexNames.length > 0,
    refetchKey: `${currentConnection?.id}|${indexNames.join(',')}`,
  });

  const isCustomRange = dateRange !== undefined;
  const rangeKey = isCustomRange
    ? `${dateRange.from.getTime()}-${dateRange.to.getTime()}`
    : 'rolling';

  const commandStatsQuery = usePolling({
    fetcher: () => {
      const endTime = isCustomRange ? dateRange.to.getTime() : Date.now();
      const startTime = isCustomRange
        ? dateRange.from.getTime()
        : endTime - DEFAULT_WINDOW_MS;
      return getCommandStatsHistory('ft.search', { startTime, endTime });
    },
    interval: isCustomRange ? 0 : COMMANDSTATS_POLL_MS,
    enabled: hasVectorSearch,
    refetchKey: `${currentConnection?.id}|${rangeKey}`,
  });

  const indexes = useMemo(() => indexInfoQuery.data ?? [], [indexInfoQuery.data]);
  const alerts = useMemo(() => deriveAlerts(indexes), [indexes]);
  const series = useMemo<CommandStatsChartPoint[]>(
    () => toChartSeries(commandStatsQuery.data ?? []),
    [commandStatsQuery.data],
  );

  const content = (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Vector / AI</h1>
          <p className="text-muted-foreground">
            FT.SEARCH workload and vector index health at a glance.
          </p>
        </div>
        <DateRangePicker
          value={dateRange}
          onChange={setDateRange}
          placeholder="Last 1 hour (live)"
        />
      </div>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((a) => (
            <Alert key={`${a.indexName}-${a.kind}`} variant="destructive">
              <AlertTitle>{a.indexName}</AlertTitle>
              <AlertDescription>{a.message}</AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>FT.SEARCH ops/sec</CardTitle>
          </CardHeader>
          <CardContent>
            {series.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {isCustomRange
                  ? 'No samples in the selected range.'
                  : 'Waiting for samples (first poll is a baseline — data appears after the next cycle).'}
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis
                    dataKey="capturedAt"
                    tickFormatter={formatTick}
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10 }} width={50} />
                  <Tooltip
                    labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                    formatter={(value) => [Number(value).toFixed(2), 'ops/sec']}
                  />
                  <Line
                    type="monotone"
                    dataKey="opsPerSec"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>FT.SEARCH avg latency (µs)</CardTitle>
          </CardHeader>
          <CardContent>
            {series.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {isCustomRange ? 'No samples in the selected range.' : 'Waiting for samples.'}
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis
                    dataKey="capturedAt"
                    tickFormatter={formatTick}
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10 }} width={60} />
                  <Tooltip
                    labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                    formatter={(value) => [Number(value).toFixed(0), 'µs']}
                  />
                  <Line
                    type="monotone"
                    dataKey="avgLatencyUs"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Vector indexes ({indexes.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {indexes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No vector indexes found on this connection.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Index</TableHead>
                  <TableHead className="text-right">Docs</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                  <TableHead className="text-right">Deleted</TableHead>
                  <TableHead className="text-right">Failures</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {indexes.map((idx) => {
                  const hasFailures = idx.indexingFailures > 0;
                  return (
                    <TableRow key={idx.name} className={hasFailures ? 'bg-destructive/5' : ''}>
                      <TableCell className="font-mono">{idx.name}</TableCell>
                      <TableCell className="text-right">{idx.numDocs.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{idx.numRecords.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{idx.numDeletedDocs.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {hasFailures ? (
                          <Badge variant="destructive">{idx.indexingFailures}</Badge>
                        ) : (
                          0
                        )}
                      </TableCell>
                      <TableCell>
                        {idx.indexingState === 'indexed' ? (
                          <Badge variant="secondary">Indexed</Badge>
                        ) : (
                          <Badge>Indexing… {idx.percentIndexed.toFixed(0)}%</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );

  if (!hasVectorSearch) {
    return (
      <UnavailableOverlay
        featureName="Vector / AI"
        command="FT._LIST"
        description={
          <>
            The Valkey/Redis Search module is not available on this connection. Either the module
            isn&rsquo;t loaded (plain Valkey / Redis without RediSearch) or{' '}
            <code className="px-1 py-0.5 bg-muted rounded text-xs">FT._LIST</code> is restricted
            by a managed service.
          </>
        }
      >
        {content}
      </UnavailableOverlay>
    );
  }

  return content;
}
