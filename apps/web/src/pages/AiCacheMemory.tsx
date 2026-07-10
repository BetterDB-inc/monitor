import { useState } from 'react';
import {
  LineChart,
  Line,
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
            <Stat label="Hit rate" value={fmtPct(latest.hitRate)} />
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

function HistoryChart({ field, kind }: { field: string; kind: AiInstanceKind }) {
  const { currentConnection } = useConnection();
  const { data, loading } = usePolling<StoredAiCacheSample[]>({
    fetcher: () => aiObservabilityApi.getHistory(field, 24),
    interval: INSTANCES_POLL_MS,
    refetchKey: `${currentConnection?.id}:${field}`,
  });
  const samples = data ?? [];

  if (loading && samples.length === 0)
    return <div className="text-sm text-muted-foreground">Loading history…</div>;
  if (samples.length === 0)
    return <div className="text-sm text-muted-foreground">No history yet for this instance.</div>;

  const chartData = samples.map((s) => ({
    t: new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    hitRate: s.hitRate === null ? null : Number((s.hitRate * 100).toFixed(1)),
    savedUsd: Number((s.costSavedMicros / 1_000_000).toFixed(4)),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData} margin={{ left: 8, right: 16, top: 16, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="t" fontSize={11} minTickGap={40} />
        <YAxis fontSize={11} unit="%" domain={[0, 100]} />
        <Tooltip />
        <Line
          type="monotone"
          dataKey="hitRate"
          name="Hit rate (%)"
          stroke={KIND_COLOR[kind]}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function AiCacheMemory() {
  const { currentConnection } = useConnection();
  const [selected, setSelected] = useState<string | null>(null);

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
    <div className="p-6 space-y-6">
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
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {selectedRow.instance.name} — hit rate (24h)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <HistoryChart
                  field={selectedRow.instance.field}
                  kind={selectedRow.instance.kind}
                />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
