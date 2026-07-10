import { useMemo, useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { aiObservabilityApi } from '../api/aiObservability';
import type { OtelTraceSummary, StoredOtelSpan, SpanCorrelation } from '@betterdb/shared';

const TRACES_POLL_MS = 10_000;

function fmtDur(ns: number): string {
  const ms = ns / 1_000_000;
  if (ms >= 1) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ns / 1000).toFixed(0)}µs`;
}

function isBetterdb(scope: string): boolean {
  return scope.startsWith('@betterdb/');
}

/** Depth of each span from its root, for waterfall indentation. */
function computeDepths(spans: StoredOtelSpan[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const depth = new Map<string, number>();
  const of = (s: StoredOtelSpan, guard = 0): number => {
    if (depth.has(s.spanId)) return depth.get(s.spanId)!;
    if (!s.parentSpanId || !byId.has(s.parentSpanId) || guard > 64) {
      depth.set(s.spanId, 0);
      return 0;
    }
    const d = of(byId.get(s.parentSpanId)!, guard + 1) + 1;
    depth.set(s.spanId, d);
    return d;
  };
  for (const s of spans) of(s);
  return depth;
}

function TraceRow({
  trace,
  selected,
  onSelect,
}: {
  trace: OtelTraceSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 rounded-md border transition-colors ${
        selected ? 'border-primary bg-accent/40' : 'border-transparent hover:bg-accent/30'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate">{trace.rootName ?? '(no root)'}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{fmtDur(trace.durationNs)}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {trace.hasError && <span className="w-2 h-2 rounded-full bg-red-500" title="Has error" />}
        <span className="truncate">{trace.serviceName ?? 'unknown'}</span>
        <span>· {trace.spanCount} spans</span>
        <span>· {trace.betterdbSpanCount} BetterDB</span>
      </div>
    </button>
  );
}

function Waterfall({
  spans,
  selectedId,
  onSelect,
}: {
  spans: StoredOtelSpan[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { min, total, depths } = useMemo(() => {
    const min = Math.min(...spans.map((s) => s.startTimeMs));
    const total =
      Math.max(...spans.map((s) => s.startTimeMs + s.durationNs / 1_000_000)) - min || 1;
    return { min, total, depths: computeDepths(spans) };
  }, [spans]);

  return (
    <div className="space-y-1">
      {spans.map((s) => {
        const offsetPct = ((s.startTimeMs - min) / total) * 100;
        const widthPct = Math.max((s.durationNs / 1_000_000 / total) * 100, 0.4);
        const depth = depths.get(s.spanId) ?? 0;
        const bd = isBetterdb(s.scopeName);
        return (
          <button
            key={s.spanId}
            onClick={() => onSelect(s.spanId)}
            className={`w-full grid grid-cols-[minmax(180px,320px)_1fr] items-center gap-3 px-2 py-1 rounded ${
              selectedId === s.spanId ? 'bg-accent/50' : 'hover:bg-accent/30'
            }`}
          >
            <span
              className="truncate text-xs text-left"
              style={{ paddingLeft: depth * 12 }}
              title={s.name}
            >
              {s.statusCode === 2 && <span className="text-red-500">● </span>}
              {s.name}
            </span>
            <span className="relative h-4">
              <span
                className="absolute top-0 h-4 rounded-sm"
                style={{
                  left: `${offsetPct}%`,
                  width: `${widthPct}%`,
                  backgroundColor: bd ? 'var(--chart-1)' : 'var(--muted-foreground)',
                  opacity: bd ? 0.9 : 0.4,
                }}
                title={`${s.name} — ${fmtDur(s.durationNs)}`}
              />
              <span
                className="absolute text-[10px] text-muted-foreground tabular-nums"
                style={{ left: `calc(${Math.min(offsetPct + widthPct, 92)}% + 4px)`, top: 1 }}
              >
                {fmtDur(s.durationNs)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SpanDetail({
  span,
  correlation,
}: {
  span: StoredOtelSpan;
  correlation: SpanCorrelation | null;
}) {
  const attrs = useMemo<Record<string, unknown>>(() => {
    try {
      return JSON.parse(span.attributes) as Record<string, unknown>;
    } catch {
      return {};
    }
  }, [span.attributes]);

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold">{span.name}</div>
        <div className="text-xs text-muted-foreground">
          {span.scopeName || 'unknown scope'} · {fmtDur(span.durationNs)}
        </div>
      </div>

      {correlation && (
        <div className="text-xs rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 space-y-1">
          <div className="font-medium text-sky-700 dark:text-sky-300">Live Valkey correlation</div>
          <div>{correlation.explanation}</div>
          <div className="text-muted-foreground flex flex-wrap gap-x-3">
            {correlation.keyExistsNow !== null && (
              <span>key: {correlation.keyExistsNow ? 'present' : 'absent'}</span>
            )}
            {correlation.keyTtlSeconds !== null && correlation.keyTtlSeconds >= 0 && (
              <span>ttl: {correlation.keyTtlSeconds}s</span>
            )}
            {correlation.threshold !== null && <span>threshold: {correlation.threshold}</span>}
            {correlation.indexState && <span>index: {correlation.indexState}</span>}
          </div>
        </div>
      )}

      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">Attributes</div>
        <div className="rounded-md border divide-y text-xs">
          {Object.keys(attrs).length === 0 && (
            <div className="px-2 py-1.5 text-muted-foreground">No attributes</div>
          )}
          {Object.entries(attrs).map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(120px,40%)_1fr] gap-2 px-2 py-1.5">
              <span className="font-mono text-muted-foreground truncate" title={k}>
                {k}
              </span>
              <span className="font-mono break-all">{String(v)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AiTraces() {
  const { currentConnection } = useConnection();
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<string | null>(null);

  const { data: tracesData, loading: tracesLoading } = usePolling<OtelTraceSummary[]>({
    fetcher: () => aiObservabilityApi.getTraces(1, 100),
    interval: TRACES_POLL_MS,
    refetchKey: currentConnection?.id,
  });
  const traces = tracesData ?? [];
  const activeTrace = selectedTrace ?? traces[0]?.traceId ?? null;

  const { data: spansData } = usePolling<StoredOtelSpan[]>({
    fetcher: () => (activeTrace ? aiObservabilityApi.getTraceSpans(activeTrace) : Promise.resolve([])),
    interval: TRACES_POLL_MS,
    enabled: !!activeTrace,
    refetchKey: activeTrace ?? undefined,
  });
  const spans = spansData ?? [];
  const activeSpan = spans.find((s) => s.spanId === selectedSpan) ?? null;

  const { data: correlationsData } = usePolling<SpanCorrelation[]>({
    fetcher: () =>
      activeTrace ? aiObservabilityApi.getTraceCorrelations(activeTrace) : Promise.resolve([]),
    interval: TRACES_POLL_MS,
    enabled: !!activeTrace,
    refetchKey: `corr:${activeTrace ?? ''}`,
  });
  const activeCorrelation =
    (correlationsData ?? []).find((c) => c.spanId === selectedSpan) ?? null;

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">AI Traces</h1>
        <p className="text-sm text-muted-foreground">
          Per-request waterfalls from OTLP traces — the BetterDB cache &amp; memory spans within
          each turn. Point an OTLP exporter at <code>/v1/traces</code> to populate this.
        </p>
      </div>

      {!tracesLoading && traces.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No traces yet. Configure your app's OTLP exporter to send to{' '}
            <code>&lt;monitor-host&gt;/v1/traces</code> (JSON protocol).
          </CardContent>
        </Card>
      )}

      {traces.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          <Card className="h-fit">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Recent traces</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 max-h-[70vh] overflow-y-auto">
              {traces.map((t) => (
                <TraceRow
                  key={t.traceId}
                  trace={t}
                  selected={activeTrace === t.traceId}
                  onSelect={() => {
                    setSelectedTrace(t.traceId);
                    setSelectedSpan(null);
                  }}
                />
              ))}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Waterfall</CardTitle>
              </CardHeader>
              <CardContent>
                {spans.length === 0 ? (
                  <div className="text-sm text-muted-foreground">Select a trace…</div>
                ) : (
                  <Waterfall spans={spans} selectedId={selectedSpan} onSelect={setSelectedSpan} />
                )}
              </CardContent>
            </Card>

            {activeSpan && (
              <Card className="h-fit">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Span</CardTitle>
                </CardHeader>
                <CardContent>
                  <SpanDetail span={activeSpan} correlation={activeCorrelation} />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
