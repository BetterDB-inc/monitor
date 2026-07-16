import { useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { aiObservabilityApi, type AiInstanceWithSample } from '../api/aiObservability';
import type { AiInstanceKind, StoredAiCacheSample } from '@betterdb/shared';

const INSTANCES_POLL_MS = 10_000;

const KIND_LABEL: Record<AiInstanceKind, string> = {
  agent_cache: 'Agent Cache',
  semantic_cache: 'Semantic Cache',
  agent_memory: 'Agent Memory',
  retrieval: 'Retrieval',
};

const KIND_COLOR: Record<AiInstanceKind, string> = {
  agent_cache: 'var(--chart-1)',
  semantic_cache: 'var(--chart-2)',
  agent_memory: 'var(--chart-3)',
  retrieval: 'var(--chart-4)',
};

function fmtUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
function fmtPct(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}
function fmtNum(n: number | null): string {
  return n === null ? '—' : n.toLocaleString();
}
/** Cumulative (lifetime) hit rate from stored counters — stable, unlike the per-tick delta. */
function cumHitRate(s: { hits: number; misses: number }): number | null {
  const total = s.hits + s.misses;
  return total > 0 ? s.hits / total : null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function InstanceCard({
  row,
  selected,
  onSelect,
}: {
  row: AiInstanceWithSample;
  selected: boolean;
  onSelect: () => void;
}) {
  const { instance, latest } = row;
  return (
    <Card
      onClick={onSelect}
      className={`cursor-pointer transition-colors ${selected ? 'ring-2 ring-primary' : 'hover:bg-accent/40'}`}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base truncate">{instance.name}</CardTitle>
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border"
            style={{ borderColor: KIND_COLOR[instance.kind], color: KIND_COLOR[instance.kind] }}
          >
            {KIND_LABEL[instance.kind]}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={`inline-block w-2 h-2 rounded-full ${instance.alive ? 'bg-green-500' : 'bg-gray-400'}`}
            title={instance.alive ? 'Heartbeat live' : 'No recent heartbeat'}
          />
          {instance.alive ? 'live' : 'stale'} · v{instance.version}
        </div>
      </CardHeader>
      <CardContent>
        {latest ? (
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Hit rate" value={fmtPct(cumHitRate(latest))} />
            <Stat label="Saved" value={fmtUsd(latest.costSavedMicros)} />
            <Stat label="Items" value={fmtNum(latest.items)} />
            <Stat label="Evictions" value={fmtNum(latest.evictions)} />
            {latest.threshold !== null && (
              <Stat label="Threshold" value={latest.threshold.toFixed(3)} />
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Awaiting first sample…</div>
        )}
      </CardContent>
    </Card>
  );
}

/** Which time-series metric a card's chart shows — memory/retrieval have no hit rate. */
function chartMetricFor(kind: AiInstanceKind): { label: string; isPercent: boolean } {
  return kind === 'agent_cache' || kind === 'semantic_cache'
    ? { label: 'hit rate', isPercent: true }
    : { label: 'items', isPercent: false };
}

function HistoryChart({
  field,
  kind,
  hours,
}: {
  field: string;
  kind: AiInstanceKind;
  hours: number;
}) {
  const { currentConnection } = useConnection();
  const { data, loading } = usePolling<StoredAiCacheSample[]>({
    fetcher: () => aiObservabilityApi.getHistory(field, hours),
    interval: INSTANCES_POLL_MS,
    refetchKey: `${currentConnection?.id}:${field}:${hours}`,
  });
  const samples = data ?? [];
  const metric = chartMetricFor(kind);

  if (loading && samples.length === 0)
    return (
      <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
        Loading history…
      </div>
    );

  const now = Date.now();
  const startMs = now - hours * 3_600_000;
  const chartData = samples.map((s) => ({
    ts: s.timestamp,
    value: metric.isPercent
      ? cumHitRate(s) === null
        ? null
        : Number((cumHitRate(s)! * 100).toFixed(1))
      : s.items,
  }));

  const hasValue = chartData.some((d) => d.value !== null && d.value !== undefined);
  if (!hasValue)
    return (
      <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
        No {metric.label} data yet
        {metric.isPercent ? ' — needs cache traffic (hits or misses).' : '.'}
      </div>
    );

  const stroke = KIND_COLOR[kind];
  const gradId = `aiobs-grad-${field.replace(/[^a-z0-9]/gi, '')}`;
  const fmtTick = (t: number) =>
    hours > 24
      ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ left: 8, right: 16, top: 16, bottom: 8 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={stroke} stopOpacity={0.35} />
            <stop offset="95%" stopColor={stroke} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={[startMs, now]}
          tickFormatter={fmtTick}
          fontSize={11}
          minTickGap={50}
        />
        <YAxis
          fontSize={11}
          unit={metric.isPercent ? '%' : ''}
          allowDecimals={false}
          // Baseline at 0 so the area fills the space under the line.
          domain={[
            0,
            (max: number) =>
              metric.isPercent ? Math.min(100, Math.ceil(max + 10)) : Math.ceil(max + 1),
          ]}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--popover-foreground)',
          }}
          labelStyle={{ color: 'var(--muted-foreground)' }}
          itemStyle={{ color: 'var(--popover-foreground)' }}
          labelFormatter={(t) => new Date(t as number).toLocaleString()}
          formatter={(v) => [metric.isPercent ? `${v}%` : v, metric.isPercent ? 'Hit rate' : 'Items']}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={2}
          fill={`url(#${gradId})`}
          connectNulls
          isAnimationActive={false}
          dot={chartData.filter((d) => d.value != null).length === 1}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const RANGES: { label: string; hours: number }[] = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

export function AiCacheMemory() {
  const { currentConnection } = useConnection();
  const [selected, setSelected] = useState<string | null>(null);
  const [rangeHours, setRangeHours] = useState<number>(24);
  const rangeLabel = RANGES.find((r) => r.hours === rangeHours)?.label ?? '24h';

  const { data, loading, error } = usePolling<AiInstanceWithSample[]>({
    fetcher: () => aiObservabilityApi.getInstances(),
    interval: INSTANCES_POLL_MS,
    refetchKey: currentConnection?.id,
  });
  const instances = data ?? [];
  const isLoading = loading;

  const selectedRow =
    instances.find((r) => r.instance.field === selected) ?? instances[0] ?? null;

  return (
    <div className="p-6 flex flex-1 flex-col gap-6 min-h-0">
      <div>
        <h1 className="text-2xl font-bold">AI Cache &amp; Memory</h1>
        <p className="text-sm text-muted-foreground">
          Caches, memory stores, and retrieval indexes discovered on this instance — hit rate,
          dollars saved, evictions, and index size, straight from the BetterDB libraries.
        </p>
      </div>

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            Failed to load AI instances: {error.message}
          </CardContent>
        </Card>
      )}

      {!error && isLoading && instances.length === 0 && (
        <div className="text-sm text-muted-foreground">Scanning for AI caches &amp; memory…</div>
      )}

      {!error && !isLoading && instances.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No BetterDB AI caches or memory stores found on this connection.{' '}
            <span className="block mt-1">
              Point <code>@betterdb/agent-cache</code>, <code>agent-memory</code>,{' '}
              <code>semantic-cache</code>, or <code>retrieval</code> at this Valkey and they'll
              appear here automatically.
            </span>
          </CardContent>
        </Card>
      )}

      {instances.length > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {instances.map((row) => (
              <InstanceCard
                key={row.instance.field}
                row={row}
                selected={selectedRow?.instance.field === row.instance.field}
                onSelect={() => setSelected(row.instance.field)}
              />
            ))}
          </div>

          {selectedRow && (
            <Card className="flex flex-1 flex-col min-h-0">
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">
                  {selectedRow.instance.name} — {chartMetricFor(selectedRow.instance.kind).label} (
                  {rangeLabel})
                </CardTitle>
                <div className="inline-flex rounded-md border p-0.5">
                  {RANGES.map((r) => (
                    <button
                      key={r.hours}
                      onClick={() => setRangeHours(r.hours)}
                      className={`px-2.5 py-1 text-xs rounded ${
                        rangeHours === r.hours
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent/50'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="relative flex-1 min-h-0">
                {/* Absolute wrapper gives the chart a definite-sized box so recharts'
                    height=100% resolves (the flex chain only has min-height). */}
                <div className="absolute inset-0 px-4 pb-4">
                  <HistoryChart
                    field={selectedRow.instance.field}
                    kind={selectedRow.instance.kind}
                    hours={rangeHours}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
