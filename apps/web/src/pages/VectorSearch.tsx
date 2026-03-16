import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { InsightCallout } from '../components/InsightCallout';
import { Search, ChevronDown, ChevronUp, ChevronRight, CheckCircle, Loader2, TrendingUp, TrendingDown, Minus, Clock, BarChart3, X } from 'lucide-react';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { useCapabilities } from '../hooks/useCapabilities';
import { metricsApi } from '../api/metrics';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { VectorIndexInfo, VectorIndexField, VectorSearchResult, VectorIndexSnapshot, TextSearchResult, FieldDistribution, ProfileResult, ProfileIterator } from '../types/metrics';

interface PollingData {
  indexes: string[];
  details: VectorIndexInfo[];
  usedMemoryBytes: number;
}

export function VectorSearch() {
  const { currentConnection } = useConnection();
  const { hasVectorSearch, isValkey } = useCapabilities();

  const fetchIndexes = useCallback(async (signal?: AbortSignal): Promise<PollingData> => {
    const { indexes } = await metricsApi.getVectorIndexList(signal);

    if (indexes.length === 0) {
      return { indexes, details: [], usedMemoryBytes: 0 };
    }

    let usedMemoryBytes = 0;
    try {
      const info = await metricsApi.getInfo(['memory']);
      usedMemoryBytes = parseInt(info.memory?.used_memory || '0', 10) || 0;
    } catch { /* don't break index list */ }

    try {
      const details = await Promise.all(
        indexes.map(name => metricsApi.getVectorIndexInfo(name))
      );
      return { indexes, details, usedMemoryBytes };
    } catch (err) {
      console.warn('Failed to fetch index details:', err);
      return { indexes, details: [], usedMemoryBytes };
    }
  }, []);

  const { data, loading, error } = usePolling<PollingData>({
    fetcher: fetchIndexes,
    interval: 30000,
    enabled: hasVectorSearch,
    refetchKey: currentConnection?.id,
  });

  if (!hasVectorSearch) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Search className="w-16 h-16 text-muted-foreground mb-4 opacity-50" />
              <h3 className="text-xl font-semibold mb-2">Search Module Not Available</h3>
              <p className="text-muted-foreground max-w-md">
                Vector search features require the Search module to be loaded.
                This instance does not have the Search module enabled.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <div className="space-y-4">
          {[1, 2].map(i => (
            <Card key={i}>
              <CardHeader><Skeleton className="h-5 w-48" /></CardHeader>
              <CardContent><Skeleton className="h-32 w-full" /></CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive">Failed to load indexes: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const indexes = data?.indexes ?? [];
  const details = data?.details ?? [];

  return (
    <div className="space-y-6">
      <PageHeader />

      {indexes.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Search className="w-16 h-16 text-muted-foreground mb-4 opacity-50" />
              <h3 className="text-xl font-semibold mb-2">No Vector Indexes Found</h3>
              <p className="text-muted-foreground max-w-md">
                No vector indexes found. Create an index with FT.CREATE to get started.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Multi-index overview when >1 index */}
          {details.length > 1 && (
            <IndexOverviewGrid details={details} usedMemoryBytes={data?.usedMemoryBytes ?? 0} />
          )}
          {details.length > 0
            ? details.map(info => (
              <IndexCard key={info.name} info={info} usedMemoryBytes={data?.usedMemoryBytes ?? 0} />
            ))
            : indexes.map(name => (
              <Card key={name}>
                <CardHeader><Skeleton className="h-5 w-48" /></CardHeader>
                <CardContent><Skeleton className="h-32 w-full" /></CardContent>
              </Card>
            ))
          }

          {/* Search Module Config — only available on RediSearch */}
          {!isValkey && <SearchConfigCard />}
        </div>
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-3xl font-bold">Vector Search</h1>
      <p className="text-muted-foreground mt-1">Index statistics for Valkey Search / Redis Search</p>
    </div>
  );
}

// --- Multi-index overview grid (feature #5) ---

function IndexOverviewGrid({ details, usedMemoryBytes }: { details: VectorIndexInfo[]; usedMemoryBytes: number }) {
  const totalDocs = details.reduce((s, d) => s + d.numDocs, 0);
  const totalMemory = details.reduce((s, d) => s + d.memorySizeMb, 0);
  const indexing = details.filter(d => d.percentIndexed < 100);
  const withFailures = details.filter(d => d.indexingFailures > 0);

  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex flex-wrap gap-6 text-sm">
          <div>
            <span className="text-muted-foreground text-xs">Indexes</span>
            <p className="font-semibold text-base">{details.length}</p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">Total Documents</span>
            <p className="font-semibold text-base">{totalDocs.toLocaleString()}</p>
          </div>
          {totalMemory > 0 && (
            <div>
              <span className="text-muted-foreground text-xs">Total Index Memory</span>
              <p className="font-semibold text-base">
                {formatMemory(totalMemory)}
                {usedMemoryBytes > 0 && (
                  <span className="text-muted-foreground text-xs ml-1">
                    ({Math.min((totalMemory * 1024 * 1024) / usedMemoryBytes * 100, 100).toFixed(1)}% of instance)
                  </span>
                )}
              </p>
            </div>
          )}
          {indexing.length > 0 && (
            <div>
              <span className="text-muted-foreground text-xs">Currently Indexing</span>
              <p className="font-semibold text-base text-amber-600">{indexing.length}</p>
            </div>
          )}
          {withFailures.length > 0 && (
            <div>
              <span className="text-muted-foreground text-xs">With Failures</span>
              <p className="font-semibold text-base text-destructive">{withFailures.length}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Sparkline with click-to-expand trend chart (feature #1) ---

function Sparkline({ snapshots, hoursLabel }: { snapshots: VectorIndexSnapshot[]; hoursLabel: string }) {
  if (snapshots.length < 3) return null;

  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const values = sorted.map(s => s.numDocs);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 80;
  const h = 24;
  const points = values.map((v, i) =>
    `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * (h - 2) - 1}`
  ).join(' ');

  // Trend indicator
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  const pctChange = first > 0 ? ((delta / first) * 100) : 0;

  return (
    <div className="min-w-[80px]">
      <span className="text-muted-foreground text-xs">docs / {hoursLabel}</span>
      <div className="flex items-center gap-1.5 mt-0.5">
        <svg width={w} height={h} className="block">
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
        </svg>
        <TrendIndicator delta={delta} pctChange={pctChange} />
      </div>
    </div>
  );
}

function TrendIndicator({ delta, pctChange }: { delta: number; pctChange: number }) {
  if (Math.abs(pctChange) < 0.1) {
    return <Minus className="w-3 h-3 text-muted-foreground" />;
  }
  if (delta > 0) {
    return (
      <span className="flex items-center gap-0.5 text-[10px] text-green-600">
        <TrendingUp className="w-3 h-3" />
        +{Math.abs(pctChange).toFixed(1)}%
      </span>
    );
  }
  return (
    <span className="flex items-center gap-0.5 text-[10px] text-red-500">
      <TrendingDown className="w-3 h-3" />
      -{Math.abs(pctChange).toFixed(1)}%
    </span>
  );
}

// --- Expanded trend chart modal (feature #1) ---

function TrendChartPanel({ snapshots, indexName, hoursLabel, onClose }: { snapshots: VectorIndexSnapshot[]; indexName: string; hoursLabel: string; onClose: () => void }) {
  const sorted = useMemo(() => [...snapshots].sort((a, b) => a.timestamp - b.timestamp), [snapshots]);

  const docData = sorted.map(s => ({
    time: new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    docs: s.numDocs,
  }));

  const memData = sorted.filter(s => s.memorySizeMb > 0).map(s => ({
    time: new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    memory: s.memorySizeMb,
  }));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="border rounded-lg p-4 bg-card space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium flex items-center gap-1.5">
          <BarChart3 className="w-4 h-4" />
          {indexName} — {hoursLabel} Trend
        </h4>
        <button onClick={onClose} className="p-1 hover:bg-muted rounded transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-1">Document Count</p>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={docData}>
            <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10 }} width={50} tickFormatter={v => v.toLocaleString()} />
            <Tooltip formatter={(v) => [Number(v).toLocaleString(), 'Documents']} />
            <Line type="monotone" dataKey="docs" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {memData.length > 3 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">Memory Usage (MB)</p>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={memData}>
              <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} width={50} tickFormatter={v => `${v.toFixed(1)}`} />
              <Tooltip formatter={(v) => [`${Number(v).toFixed(2)} MB`, 'Memory']} />
              <Area type="monotone" dataKey="memory" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.1} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function IndexCard({ info, usedMemoryBytes }: { info: VectorIndexInfo; usedMemoryBytes: number }) {
  const { currentConnection } = useConnection();
  const [showDetails, setShowDetails] = useState(false);
  const [showTrendChart, setShowTrendChart] = useState(false);
  const [snapshots, setSnapshots] = useState<VectorIndexSnapshot[] | null>(null);
  const [snapshotHours, setSnapshotHours] = useState(24);
  const insights = getInsights(info);
  const vectorField = info.fields.find(f => f.type === 'VECTOR');
  const semanticCache = isSemanticCache(info);

  useEffect(() => {
    setSnapshots(null);
    metricsApi.getVectorIndexSnapshots(info.name, snapshotHours)
      .then(res => setSnapshots(res.snapshots))
      .catch(() => { /* ignore */ });
  }, [info.name, currentConnection?.id, snapshotHours]);

  const hoursLabel = snapshotHours <= 24 ? `${snapshotHours}h` : '7d';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <CardTitle className="text-lg font-semibold truncate">{info.name}</CardTitle>
            {semanticCache && <Badge variant="secondary">Semantic Cache</Badge>}
          </div>
          <StatusBadge info={info} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Indexing progress bar (feature #2) */}
        {info.percentIndexed < 100 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                Indexing in progress
              </span>
              <span className="font-medium">{Math.round(info.percentIndexed)}%</span>
            </div>
            <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-500"
                style={{ width: `${Math.min(info.percentIndexed, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Section 1: Overview row */}
        <div className="flex flex-wrap gap-6 text-sm">
          <StatItem label="Documents" value={info.numDocs.toLocaleString()} />
          <StatItem
            label="Records"
            value={info.numRecords.toLocaleString()}
            tooltip="Records includes duplicates from document updates. A large gap between Records and Documents indicates index fragmentation."
          />
          <StatItem label="Vector Fields" value={info.numVectorFields.toLocaleString()} />
          {info.memorySizeMb > 0 && (
            <StatItem label="Memory" value={
              <>
                {formatMemory(info.memorySizeMb)}
                {usedMemoryBytes > 0 && (
                  <span className="text-muted-foreground text-xs ml-1">
                    ({Math.min((info.memorySizeMb * 1024 * 1024) / usedMemoryBytes * 100, 100).toFixed(1)}% of instance)
                  </span>
                )}
              </>
            } />
          )}
          {snapshots && snapshots.length >= 3 && (
            <button
              onClick={() => setShowTrendChart(prev => !prev)}
              className="hover:bg-muted/50 rounded px-1 -mx-1 transition-colors"
              title="Click to expand trend chart"
            >
              <Sparkline snapshots={snapshots} hoursLabel={hoursLabel} />
            </button>
          )}
          {snapshots && snapshots.length < 3 && <Sparkline snapshots={snapshots} hoursLabel={hoursLabel} />}
          {/* Snapshot time window control */}
          <div className="inline-flex items-center border rounded overflow-hidden ml-auto">
            {([6, 24, 168] as const).map(h => (
              <button
                key={h}
                onClick={() => setSnapshotHours(h)}
                className={`px-1.5 py-0.5 text-[11px] leading-tight ${snapshotHours === h ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {h <= 24 ? `${h}h` : '7d'}
              </button>
            ))}
          </div>
        </div>

        {/* Expanded trend chart (feature #1) */}
        {showTrendChart && snapshots && snapshots.length >= 3 && (
          <TrendChartPanel snapshots={snapshots} indexName={info.name} hoursLabel={hoursLabel} onClose={() => setShowTrendChart(false)} />
        )}

        {/* GC stats summary (feature #3) — promoted from collapsible */}
        {info.gcStats && (
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
            <span>GC Cycles: <span className="font-medium text-foreground">{info.gcStats.gcCycles.toLocaleString()}</span></span>
            <span>Bytes Collected: <span className="font-medium text-foreground">{formatBytes(info.gcStats.bytesCollected)}</span></span>
            <span>GC Time: <span className="font-medium text-foreground">{info.gcStats.totalMsRun.toLocaleString()} ms</span></span>
          </div>
        )}

        {/* Insight callouts */}
        {insights.length > 0 ? (
          <div className="space-y-2">
            {insights.map((insight, i) => (
              <InsightCallout key={i} severity={insight.severity} title={insight.title} description={insight.description} docUrl={insight.docUrl} docLabel={insight.docLabel}>
                {insight.copyCommand && <CopyButton text={insight.copyCommand.text} label={insight.copyCommand.label} />}
              </InsightCallout>
            ))}
          </div>
        ) : (
          <p className="text-sm text-green-600 dark:text-green-500 flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5" />
            No issues detected
          </p>
        )}

        {/* Section 2: Schema */}
        <div>
          <h4 className="text-sm font-medium text-muted-foreground mb-2">Schema</h4>
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-3 py-1.5 font-medium">Field</th>
                  <th className="text-left px-3 py-1.5 font-medium">Type</th>
                  <th className="text-left px-3 py-1.5 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {info.fields.map(field => (
                  <tr key={field.name} className="border-b last:border-0">
                    <td className="px-3 py-1.5 font-mono text-xs">{field.name}</td>
                    <td className="px-3 py-1.5">
                      <Badge variant={field.type === 'VECTOR' ? 'default' : 'secondary'} className="text-xs">
                        {field.type}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      <FieldDetails field={field} indexName={info.name} />
                    </td>
                  </tr>
                ))}
                {info.fields.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-center text-muted-foreground">No fields</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 3: Advanced stats (collapsible) */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          {showDetails ? 'Hide details' : 'Show details'}
        </button>

        {showDetails && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm pt-1">
            <div className="space-y-1">
              <h4 className="font-medium text-muted-foreground">Index Definition</h4>
              <dl className="space-y-1">
                <div className="flex gap-2">
                  <dt className="text-muted-foreground min-w-[100px]">Prefixes</dt>
                  <dd className="font-mono text-xs">
                    {info.indexDefinition?.prefixes.length
                      ? info.indexDefinition.prefixes.join(', ')
                      : '*'}
                  </dd>
                </div>
                {info.indexDefinition?.defaultLanguage && (
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground min-w-[100px]">Language</dt>
                    <dd>{info.indexDefinition.defaultLanguage}</dd>
                  </div>
                )}
                {info.indexDefinition?.defaultScore != null && (
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground min-w-[100px]">Default Score</dt>
                    <dd>{info.indexDefinition.defaultScore}</dd>
                  </div>
                )}
                {vectorField && (
                  <>
                    {vectorField.dimension != null && (
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground min-w-[100px]">Dimension</dt>
                        <dd>{vectorField.dimension}</dd>
                      </div>
                    )}
                    {vectorField.distanceMetric && (
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground min-w-[100px]">Distance</dt>
                        <dd>{vectorField.distanceMetric}</dd>
                      </div>
                    )}
                    {vectorField.algorithm && (
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground min-w-[100px]">Algorithm</dt>
                        <dd>{vectorField.algorithm}</dd>
                      </div>
                    )}
                  </>
                )}
              </dl>
            </div>

            {info.gcStats && (
              <div className="space-y-1">
                <h4 className="font-medium text-muted-foreground">GC Stats</h4>
                <dl className="space-y-1">
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground min-w-[100px]">Cycles</dt>
                    <dd>{info.gcStats.gcCycles.toLocaleString()}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground min-w-[100px]">Bytes Collected</dt>
                    <dd>{formatBytes(info.gcStats.bytesCollected)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground min-w-[100px]">Total Time</dt>
                    <dd>{info.gcStats.totalMsRun.toLocaleString()} ms</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        )}

        {/* Section 4: Similarity Search */}
        <SearchTester info={info} />
      </CardContent>
    </Card>
  );
}

// --- Schema field details ---

const HNSW_TOOLTIP = [
  'M: Max connections per node in the graph. Higher = better recall and more memory. Default 16, max 512.',
  'ef_construction: Candidates examined while building the index. Higher = better index quality, slower builds. Default 200.',
  'ef_runtime: Candidates examined per query. Higher = better recall, slower queries. Can be overridden per-query with EF_RUNTIME.',
].join('\n');

function FieldDetails({ field, indexName }: { field: VectorIndexField; indexName: string }) {
  if (field.type === 'VECTOR') {
    const primary = [
      field.dimension != null ? `dim=${field.dimension}` : null,
      field.distanceMetric,
      field.algorithm,
    ].filter(Boolean).join(' \u00b7 ') || '\u2014';

    const hasHnswParams = field.hnswM != null || field.hnswEfConstruction != null || field.hnswEfRuntime != null;
    const hnswParts = [
      field.hnswM != null ? `M=${field.hnswM}` : null,
      field.hnswEfConstruction != null ? `ef_construction=${field.hnswEfConstruction}` : null,
      field.hnswEfRuntime != null ? `ef_runtime=${field.hnswEfRuntime}` : null,
    ].filter(Boolean).join(' \u00b7 ');

    return (
      <div>
        <span>{primary}</span>
        {hasHnswParams && (
          <div className="text-xs text-muted-foreground/70 mt-0.5" title={HNSW_TOOLTIP}>
            {hnswParts}
          </div>
        )}
      </div>
    );
  }

  const parts: string[] = [];
  const badges: string[] = [];

  if (field.type === 'TAG') {
    if (field.separator && field.separator !== ',') {
      parts.push(`separator="${field.separator}"`);
    }
    if (field.caseSensitive) badges.push('CASESENSITIVE');
    if (field.sortable) badges.push('SORTABLE');
  } else if (field.type === 'NUMERIC') {
    if (field.sortable) badges.push('SORTABLE');
  } else if (field.type === 'TEXT') {
    if (field.noStem) badges.push('NOSTEM');
    if (field.weight != null && field.weight !== 1.0) {
      parts.push(`weight=${field.weight}`);
    }
    if (field.sortable) badges.push('SORTABLE');
  }

  const showTagExplorer = field.type === 'TAG';

  if (parts.length === 0 && badges.length === 0 && !showTagExplorer) return null;

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      {parts.length > 0 && <span>{parts.join(' \u00b7 ')}</span>}
      {badges.map(b => (
        <Badge key={b} variant="outline" className="text-[10px] px-1 py-0">{b}</Badge>
      ))}
      {showTagExplorer && <TagValueExplorer indexName={indexName} fieldName={field.name} />}
    </span>
  );
}

// --- Helpers ---

function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function getKeyLabel(fields: Record<string, string>, nonVectorFields: VectorIndexField[]): string | null {
  // Try first TEXT field, then first TAG field
  for (const type of ['TEXT', 'TAG']) {
    const field = nonVectorFields.find(f => f.type === type);
    if (field && fields[field.name]) {
      const val = fields[field.name];
      return val.length > 80 ? val.slice(0, 77) + '…' : val;
    }
  }
  return null;
}

// --- Field classification ---

type FieldClass = 'title' | 'timestamp' | 'proportion' | 'json' | 'default';

/** Pure classifier — no React, no side effects. */
function classifyField(name: string, value: string, allValues: string[]): FieldClass {
  // timestamp: 13-digit Unix ms, or valid ISO 8601 (contains T or -)
  const isIdLike = /id/i.test(name) && /^[0-9a-f]{8}-/i.test(value);
  if (!isIdLike) {
    if (/^\d{13}$/.test(value)) return 'timestamp';
    if ((value.includes('T') || value.includes('-')) && !isNaN(new Date(value).getTime())) return 'timestamp';
  }

  // proportion: float 0-1, consistently across all sampled values
  if (!/(?:id|version|count)/i.test(name)) {
    const num = parseFloat(value);
    if (!isNaN(num) && num >= 0 && num <= 1 && allValues.length > 0) {
      if (allValues.every(v => { const n = parseFloat(v); return !isNaN(n) && n >= 0 && n <= 1; })) {
        return 'proportion';
      }
    }
  }

  // json: starts with { or [ and parses
  if ((value.startsWith('{') || value.startsWith('[')) && value.length > 1) {
    try { JSON.parse(value); return 'json'; } catch { /* not json */ }
  }

  // title candidate: sentence-like text (>20 chars, >=2 spaces)
  if (value.length > 20 && (value.match(/ /g) || []).length >= 2) return 'title';

  return 'default';
}

function parseTimestampValue(value: string): number {
  if (/^\d{13}$/.test(value)) return parseInt(value, 10);
  return new Date(value).getTime();
}

type FieldRole = 'identifier' | 'provenance' | 'temporal' | 'metric' | 'payload' | 'content' | 'default';

interface FieldMeta {
  name: string;
  classification: FieldClass;
  role: FieldRole;
  avgLength: number;
  allValuesAreShort: boolean;
}

const PROVENANCE_RE = /(?:project|branch|source|origin|author|user|tenant)/i;
const METRIC_NAME_RE = /(?:score|rate|rank|weight)/i;
const ID_SUFFIX_RE = /(?:id|Id|key)$/;

function detectRole(name: string, cls: FieldClass, avgLength: number, allValues: string[]): FieldRole {
  // identifier: UUID-like values, or field name ends with id/Id/key
  if (ID_SUFFIX_RE.test(name)) return 'identifier';
  if (allValues.length > 0 && allValues.every(v => /^[0-9a-f]{8}-/i.test(v))) return 'identifier';

  // provenance
  if (PROVENANCE_RE.test(name)) return 'provenance';

  // temporal
  if (cls === 'timestamp') return 'temporal';

  // metric
  if (cls === 'proportion') return 'metric';
  if (METRIC_NAME_RE.test(name)) return 'metric';

  // payload
  if (cls === 'json') return 'payload';

  // content
  if (cls === 'title') return 'content';
  if (avgLength > 60) return 'content';

  return 'default';
}

function buildFieldMeta(docs: Array<{ fields: Record<string, string> }>): Record<string, FieldMeta> {
  const allValues: Record<string, string[]> = {};
  for (const doc of docs) {
    for (const [k, v] of Object.entries(doc.fields)) {
      if (!allValues[k]) allValues[k] = [];
      allValues[k].push(v);
    }
  }

  const meta: Record<string, FieldMeta> = {};
  for (const [name, values] of Object.entries(allValues)) {
    const avg = values.reduce((s, v) => s + v.length, 0) / values.length;
    const representative = values[0] ?? '';
    const cls = classifyField(name, representative, values);
    meta[name] = {
      name,
      classification: cls,
      role: detectRole(name, cls, avg, values),
      avgLength: avg,
      allValuesAreShort: avg < 30,
    };
  }
  return meta;
}

function humanizeFieldName(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

function formatRelativeTime(timestamp: number): string {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const delta = timestamp - Date.now();
  const abs = Math.abs(delta);
  const sign = delta < 0 ? -1 : 1;
  const secs = abs / 1000;
  if (secs < 60) return rtf.format(Math.round(sign * secs), 'second');
  const mins = secs / 60;
  if (mins < 60) return rtf.format(Math.round(sign * mins), 'minute');
  const hrs = mins / 60;
  if (hrs < 24) return rtf.format(Math.round(sign * hrs), 'hour');
  const days = hrs / 24;
  if (days < 30) return rtf.format(Math.round(sign * days), 'day');
  const months = days / 30.44;
  if (months < 12) return rtf.format(Math.round(sign * months), 'month');
  return rtf.format(Math.round(sign * days / 365.25), 'year');
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fallback */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function buildFtCreateCommand(info: VectorIndexInfo, opts?: { forceHnsw?: boolean }): string {
  const parts: string[] = ['FT.CREATE', info.name, 'ON', 'HASH'];
  const prefixes = info.indexDefinition?.prefixes ?? [];
  if (prefixes.length > 0) parts.push('PREFIX', String(prefixes.length), ...prefixes);
  parts.push('SCHEMA');
  for (const field of info.fields) {
    parts.push(field.name);
    if (field.type === 'VECTOR') {
      const useHnsw = opts?.forceHnsw;
      const attrs: string[] = ['TYPE', 'FLOAT32'];
      if (field.dimension != null) attrs.push('DIM', String(field.dimension));
      if (field.distanceMetric) attrs.push('DISTANCE_METRIC', field.distanceMetric);
      if (useHnsw || field.algorithm === 'HNSW') {
        attrs.push('M', useHnsw ? '16' : String(field.hnswM ?? 16));
        attrs.push('EF_CONSTRUCTION', useHnsw ? '200' : String(field.hnswEfConstruction ?? 200));
      }
      parts.push('VECTOR', useHnsw ? 'HNSW' : (field.algorithm ?? 'HNSW'), String(attrs.length), ...attrs);
    } else if (field.type === 'TAG') {
      parts.push('TAG');
      if (field.separator && field.separator !== ',') parts.push('SEPARATOR', field.separator);
      if (field.caseSensitive) parts.push('CASESENSITIVE');
    } else if (field.type === 'NUMERIC') {
      parts.push('NUMERIC');
      if (field.sortable) parts.push('SORTABLE');
    } else if (field.type === 'TEXT') {
      parts.push('TEXT');
      if (field.noStem) parts.push('NOSTEM');
      if (field.weight != null && field.weight !== 1.0) parts.push('WEIGHT', String(field.weight));
      if (field.sortable) parts.push('SORTABLE');
    } else {
      parts.push(field.type);
    }
  }
  return parts.join(' ');
}

function CopyButton({ text, label = 'Copy commands' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        await copyToClipboard(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="mt-1 px-2.5 py-1 text-xs font-medium border rounded-md hover:bg-background/50 transition-colors"
    >
      {copied ? 'Copied \u2713' : label}
    </button>
  );
}

function getKeyLastSegment(docKey: string): string {
  const parts = docKey.split(':');
  return parts[parts.length - 1];
}

function groupFieldsByRole(
  fields: Record<string, string>,
  meta: Record<string, FieldMeta>,
  docKey: string,
): Record<FieldRole, Array<{ key: string; value: string }>> {
  const groups: Record<FieldRole, Array<{ key: string; value: string }>> = {
    content: [], metric: [], temporal: [], provenance: [], default: [], identifier: [], payload: [],
  };
  const keySuffix = getKeyLastSegment(docKey);
  let contentFound = false;

  for (const [k, v] of Object.entries(fields)) {
    // Identifier deduplication: skip if value matches the key's last segment
    if (v === keySuffix) continue;

    const m = meta[k];
    let role: FieldRole = m?.role ?? 'default';

    // Only promote one content field
    if (role === 'content') {
      if (contentFound) role = 'default';
      else contentFound = true;
    }

    groups[role].push({ key: k, value: v });
  }
  return groups;
}

function FieldGrid({ fields, fieldMeta, docKey }: { fields: Record<string, string>; fieldMeta: Record<string, FieldMeta>; docKey: string }) {
  const [expandedJson, setExpandedJson] = useState<Set<string>>(new Set());
  const [showIds, setShowIds] = useState(false);

  const entries = Object.entries(fields);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No fields returned</p>;

  const groups = groupFieldsByRole(fields, fieldMeta, docKey);

  return (
    <div>
      {/* content */}
      {groups.content.map(({ key: k, value: v }) => (
        <p key={k} className="text-sm font-medium text-foreground">{v}</p>
      ))}

      {/* metric */}
      {groups.metric.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
          {groups.metric.map(({ key: k, value: v }) => {
            const m = fieldMeta[k];
            if (m?.classification === 'proportion') {
              const score = parseFloat(v);
              const color = score >= 0.7 ? 'bg-green-500' : score >= 0.4 ? 'bg-amber-400' : 'bg-red-400';
              return (
                <span key={k} className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-500 dark:text-gray-400">{humanizeFieldName(k)}</span>
                  <span className="h-1.5 w-12 rounded-full bg-muted overflow-hidden inline-block">
                    <span className={`block h-1.5 rounded-full ${color}`} style={{ width: `${score * 100}%` }} />
                  </span>
                  <span className="font-mono">{Math.round(score * 100)}%</span>
                </span>
              );
            }
            return (
              <span key={k} className="text-xs">
                <span className="text-gray-500 dark:text-gray-400">{humanizeFieldName(k)}</span>{' '}
                <span className="font-mono">{v}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* temporal — deduplicate identical relative times */}
      {groups.temporal.length > 0 && (() => {
        const byRelative = new Map<string, { names: string[]; iso: string }>();
        for (const { key: k, value: v } of groups.temporal) {
          const ts = parseTimestampValue(v);
          const rel = formatRelativeTime(ts);
          const existing = byRelative.get(rel);
          if (existing) {
            existing.names.push(k);
          } else {
            byRelative.set(rel, { names: [k], iso: new Date(ts).toISOString() });
          }
        }
        return (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {[...byRelative.entries()].map(([rel, { names, iso }]) => (
              <span key={names.join(',')} className="text-xs">
                <span className="text-gray-500 dark:text-gray-400">{names.map(humanizeFieldName).join(', ')}</span>{' '}
                <span className="font-mono" title={iso}>{rel}</span>
              </span>
            ))}
          </div>
        );
      })()}

      {/* provenance */}
      {groups.provenance.length > 0 && (
        <div className="grid gap-x-4 gap-y-0.5 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
          {groups.provenance.map(({ key: k, value: v }) => (
            <div key={k} className="min-w-0">
              <span className="text-xs text-gray-400 dark:text-gray-500">{humanizeFieldName(k)}</span>
              <p className="text-xs font-medium truncate">{v}</p>
            </div>
          ))}
        </div>
      )}

      {/* default */}
      {groups.default.length > 0 && (
        <div className="grid gap-x-4 gap-y-0.5 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          {groups.default.map(({ key: k, value: v }) => (
            <div key={k} className="min-w-0">
              <span className="text-xs text-gray-400 dark:text-gray-500">{humanizeFieldName(k)}</span>
              {v.length > 200 ? (
                <LongValue value={v} />
              ) : (
                <p className="text-xs font-mono truncate" title={v}>{v}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* identifier */}
      {groups.identifier.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowIds(prev => !prev)}
            className="text-xs text-gray-400 dark:text-gray-500 cursor-pointer hover:text-foreground transition-colors"
          >
            {showIds ? 'Hide identifiers \u2191' : 'Show identifiers \u2193'}
          </button>
          {showIds && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
              {groups.identifier.map(({ key: k, value: v }) => (
                <span key={k} className="text-xs text-gray-400 dark:text-gray-500 font-mono">
                  {humanizeFieldName(k)}: {v}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* payload */}
      {groups.payload.map(({ key: k, value: v }) => {
        const isExpanded = expandedJson.has(k);
        let pretty = v;
        try { pretty = JSON.stringify(JSON.parse(v), null, 2); } catch { /* use raw */ }
        return (
          <div key={k} className="mt-2">
            <button
              onClick={() => setExpandedJson(prev => toggleInSet(prev, k))}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {isExpanded ? `Hide ${humanizeFieldName(k)}` : `Show ${humanizeFieldName(k)}`}
            </button>
            {isExpanded && (
              <pre className="text-xs overflow-auto max-h-48 mt-1 p-2 bg-muted/50 rounded whitespace-pre-wrap font-mono">{pretty}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LongValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="text-xs font-mono break-all">
      {expanded ? value : value.slice(0, 200) + '\u2026'}
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="text-primary ml-1 text-[10px]"
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

// --- Search tester ---

type SearchTab = 'browse' | 'similar' | 'text' | 'distribution' | 'profile' | 'graph';

function SearchTester({ info }: { info: VectorIndexInfo }) {
  const { isValkey } = useCapabilities();
  const vectorFields = info.fields.filter(f => f.type === 'VECTOR');
  const nonVectorFields = info.fields.filter(f => f.type !== 'VECTOR');

  const [tab, setTab] = useState<SearchTab>('browse');

  // --- Expanded rows (key-based, separate per tab) ---
  const [simExpanded, setSimExpanded] = useState<Set<string>>(new Set());
  const [browseExpanded, setBrowseExpanded] = useState<Set<string>>(new Set());

  // --- Find Similar state ---
  const [sourceKey, setSourceKey] = useState('');
  const [vectorField, setVectorField] = useState(vectorFields[0]?.name ?? '');
  const [k, setK] = useState(10);
  const [filter, setFilter] = useState('');
  const [simResults, setSimResults] = useState<VectorSearchResult[] | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [searchLatencyMs, setSearchLatencyMs] = useState<number | null>(null);

  // --- Key picker state ---
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKeys, setPickerKeys] = useState<Array<{ key: string; fields: Record<string, string> }>>([]);
  const [pickerCursor, setPickerCursor] = useState('0');
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerDone, setPickerDone] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // --- Browse state ---
  const [browseFilter, setBrowseFilter] = useState('');
  const [browseKeys, setBrowseKeys] = useState<Array<{ key: string; fields: Record<string, string> }>>([]);
  const [browseCursor, setBrowseCursor] = useState('0');
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseDone, setBrowseDone] = useState(false);
  const [browseLoaded, setBrowseLoaded] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  if (vectorFields.length === 0) return null;

  const searchedField = info.fields.find(f => f.name === vectorField);
  const isCosine = searchedField?.distanceMetric?.toUpperCase() === 'COSINE';

  const filterableFields = nonVectorFields;
  const filterPlaceholder = filterableFields.length > 0
    ? `@${filterableFields[0].name}:{value}`
    : '@field:{value}';

  // --- Key picker ---
  const loadPickerKeys = async (cursor: string) => {
    if (pickerLoading) return;
    setPickerLoading(true);
    try {
      const { keys, cursor: nextCursor } = await metricsApi.sampleIndexKeys(info.name, { cursor, limit: 50 });
      setPickerKeys(prev => cursor === '0' ? keys : [...prev, ...keys]);
      setPickerCursor(nextCursor);
      setPickerDone(nextCursor === '0');
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : 'Failed to load keys');
    } finally {
      setPickerLoading(false);
    }
  };

  const openPicker = () => {
    if (!pickerOpen) {
      setPickerOpen(true);
      if (pickerKeys.length === 0) loadPickerKeys('0');
    } else {
      setPickerOpen(false);
    }
  };

  const selectKey = (key: string) => {
    setSourceKey(key);
    setPickerOpen(false);
  };

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  // --- Find Similar ---
  const handleSearch = async (keyOverride?: string) => {
    const key = keyOverride ?? sourceKey.trim();
    if (!key) return;
    if (!keyOverride) setSourceKey(key);
    setTab('similar');
    setSimLoading(true);
    setSimError(null);
    setSimResults(null);
    setSimExpanded(new Set());
    setSearchLatencyMs(null);
    const t0 = performance.now();
    try {
      const { results: res } = await metricsApi.vectorSearch(info.name, {
        sourceKey: key,
        vectorField,
        k,
        filter: filter.trim() || undefined,
      });
      setSearchLatencyMs(Math.round(performance.now() - t0));
      setSimResults(res);
    } catch (err) {
      if (err instanceof Error) {
        setSimError(err.message.includes('404')
          ? 'Key not found — make sure the key exists and the field contains a vector'
          : err.message);
      } else {
        setSimError('Search failed');
      }
    } finally {
      setSimLoading(false);
    }
  };

  const handleFindSimilar = (key: string) => {
    setSourceKey(key);
    handleSearch(key);
  };

  const formatScore = (score: number) => {
    if (isCosine) return `${((1 - score) * 100).toFixed(1)}%`;
    return score.toFixed(4);
  };

  // --- Browse ---
  const loadBrowseKeys = async (cursor: string) => {
    if (browseLoading) return;
    setBrowseLoading(true);
    try {
      const { keys, cursor: nextCursor } = await metricsApi.sampleIndexKeys(info.name, { cursor, limit: 100 });
      setBrowseKeys(prev => cursor === '0' ? keys : [...prev, ...keys]);
      setBrowseCursor(nextCursor);
      setBrowseDone(nextCursor === '0');
      setBrowseLoaded(true);
      setBrowseError(null);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setBrowseLoading(false);
    }
  };

  const filteredBrowseKeys = browseFilter.trim()
    ? browseKeys.filter(({ key, fields }) => {
        const q = browseFilter.trim().toLowerCase();
        if (key.toLowerCase().includes(q)) return true;
        return Object.values(fields).some(v => v.toLowerCase().includes(q));
      })
    : browseKeys;

  // Field meta for adaptive layout
  const simFieldMeta = useMemo(() => buildFieldMeta(simResults ?? []), [simResults]);
  const browseFieldMeta = useMemo(() => buildFieldMeta(browseKeys), [browseKeys]);

  // --- Tab bar ---
  const tabClass = (t: SearchTab) =>
    `px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
      tab === t
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
    }`;

  return (
    <div className="border-t pt-4 space-y-3">
      {/* Tabs */}
      <div className="flex gap-1 border-b flex-wrap">
        <button className={tabClass('browse')} onClick={() => setTab('browse')}>Browse</button>
        <button className={tabClass('similar')} onClick={() => setTab('similar')}>Find Similar</button>
        {!isValkey && info.fields.some(f => f.type === 'TEXT' || f.type === 'TAG') && (
          <button className={tabClass('text')} onClick={() => setTab('text')}>Text Search</button>
        )}
        <button className={tabClass('distribution')} onClick={() => setTab('distribution')}>Data</button>
        {vectorFields.length > 0 && (
          <button className={tabClass('graph')} onClick={() => setTab('graph')}>Graph</button>
        )}
        {!isValkey && (
          <button className={tabClass('profile')} onClick={() => setTab('profile')}>Profiler</button>
        )}
      </div>

      {/* === Find Similar Tab === */}
      {tab === 'similar' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Pick or type a source key, then find its nearest neighbors by vector similarity.</p>

          <div className="flex flex-wrap gap-3 items-end">
            {/* Source key with picker */}
            <div className="flex-1 min-w-[200px] relative" ref={pickerRef}>
              <label className="text-xs text-muted-foreground block mb-1">Source key</label>
              <div className="flex">
                <input
                  type="text"
                  value={sourceKey}
                  onChange={e => setSourceKey(e.target.value)}
                  placeholder={info.indexDefinition?.prefixes?.[0] ? `${info.indexDefinition.prefixes[0]}example` : 'mykey:123'}
                  className="flex-1 px-2.5 py-1.5 text-sm border rounded-l-md bg-background font-mono"
                  onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
                />
                <button
                  onClick={openPicker}
                  className="px-2 py-1.5 text-sm border border-l-0 rounded-r-md bg-muted hover:bg-muted/80 transition-colors"
                  title="Browse keys"
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
                </button>
              </div>

              {/* Key picker dropdown */}
              {pickerOpen && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg max-h-[300px] overflow-y-auto">
                  {pickerError && (
                    <p className="px-3 py-2 text-sm text-destructive text-center">{pickerError}</p>
                  )}
                  {pickerKeys.length === 0 && !pickerLoading && !pickerError && (
                    <p className="px-3 py-4 text-sm text-muted-foreground text-center">No keys found for this index</p>
                  )}
                  {pickerKeys.map(({ key, fields }) => {
                    const label = getKeyLabel(fields, nonVectorFields);
                    return (
                      <button
                        key={key}
                        onClick={() => selectKey(key)}
                        className="w-full text-left px-3 py-2 hover:bg-accent transition-colors border-b last:border-0"
                      >
                        <span className="text-xs font-mono block truncate">{key}</span>
                        {label && <span className="text-[11px] text-muted-foreground block truncate">{label}</span>}
                      </button>
                    );
                  })}
                  {!pickerDone && (
                    <button
                      onClick={() => loadPickerKeys(pickerCursor)}
                      disabled={pickerLoading}
                      className="w-full px-3 py-2 text-xs text-primary hover:bg-accent transition-colors flex items-center justify-center gap-1"
                    >
                      {pickerLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                      {pickerLoading ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Vector field selector */}
            {vectorFields.length > 1 ? (
              <div className="min-w-[140px]">
                <label className="text-xs text-muted-foreground block mb-1">Vector field</label>
                <select
                  value={vectorField}
                  onChange={e => setVectorField(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background"
                >
                  {vectorFields.map(f => (
                    <option key={f.name} value={f.name}>{f.name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="min-w-[100px]">
                <label className="text-xs text-muted-foreground block mb-1">Vector field</label>
                <input type="text" value={vectorField} disabled className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-muted font-mono" />
              </div>
            )}

            <div className="w-[80px]">
              <label className="text-xs text-muted-foreground block mb-1">K</label>
              <input
                type="number"
                value={k}
                onChange={e => setK(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
                min={1}
                max={50}
                className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background"
              />
            </div>

            <button
              onClick={() => handleSearch()}
              disabled={simLoading || !sourceKey.trim()}
              className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {simLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              Search
            </button>
          </div>

          {/* Filter */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Filter <span className="opacity-60">(optional)</span>
            </label>
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={filterPlaceholder}
              className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono"
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
            />
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">
              Pre-filter results using FT.SEARCH query syntax, e.g. <code className="font-mono">@tag:{'{'}value{'}'}</code> or <code className="font-mono">@price:[0 100]</code>
            </p>
          </div>

          {/* Results */}
          {simError && <p className="text-sm text-destructive">{simError}</p>}
          {simResults && simResults.length === 0 && <p className="text-sm text-muted-foreground">No results found.</p>}
          {simResults && simResults.length > 0 && searchLatencyMs != null && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              <span>{simResults.length} result{simResults.length !== 1 ? 's' : ''} in <span className="font-medium text-foreground">{searchLatencyMs} ms</span></span>
            </div>
          )}
          {simResults && simResults.length > 0 && (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-3 py-1.5 font-medium w-[50px]">Rank</th>
                    <th className="text-left px-3 py-1.5 font-medium">Key</th>
                    <th className="text-right px-3 py-1.5 font-medium w-[100px]">{isCosine ? 'Similarity' : 'Score'}</th>
                    <th className="w-[90px]" />
                  </tr>
                </thead>
                <tbody>
                  {simResults.map((result, idx) => (
                    <Fragment key={`${idx}-${result.key}`}>
                      <tr
                        onClick={() => setSimExpanded(prev => toggleInSet(prev, result.key))}
                        className="border-b last:border-0 cursor-pointer hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-3 py-1.5 text-muted-foreground">{idx + 1}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">
                          <span className="flex items-center gap-1">
                            <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${simExpanded.has(result.key) ? 'rotate-90' : ''}`} />
                            {result.key}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-xs">{formatScore(result.score)}</td>
                        <td className="px-3 py-1.5 text-right">
                          <button
                            onClick={e => { e.stopPropagation(); handleFindSimilar(result.key); }}
                            className="text-[11px] text-primary hover:text-primary/80 font-medium"
                            title={`Find keys similar to ${result.key}`}
                          >
                            Find similar
                          </button>
                        </td>
                      </tr>
                      {simExpanded.has(result.key) && (
                        <tr className="border-b last:border-0 bg-muted/20">
                          <td colSpan={4} className="px-3 py-2">
                            <FieldGrid fields={result.fields} fieldMeta={simFieldMeta} docKey={result.key} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* === Browse Tab === */}
      {tab === 'browse' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Browse documents in this index. Use the filter to search across key names and field values.</p>

          {!browseLoaded && !browseLoading && (
            <button
              onClick={() => loadBrowseKeys('0')}
              className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-1.5"
            >
              <Search className="w-3.5 h-3.5" />
              Load documents
            </button>
          )}

          {browseLoaded && (
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Filter <span className="opacity-60">(searches key names and field values)</span>
              </label>
              <input
                type="text"
                value={browseFilter}
                onChange={e => setBrowseFilter(e.target.value)}
                placeholder="Type to filter..."
                className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background"
                list={`browse-fields-${info.name}`}
              />
              {/* Auto-suggest field names (feature #6) */}
              <datalist id={`browse-fields-${info.name}`}>
                {nonVectorFields.map(f => (
                  <option key={f.name} value={f.name} />
                ))}
              </datalist>
              {/* Prefix breakdown when multiple prefixes */}
              {info.indexDefinition?.prefixes && info.indexDefinition.prefixes.length > 1 && browseKeys.length > 0 && (
                <PrefixBreakdown keys={browseKeys} prefixes={info.indexDefinition.prefixes} />
              )}
            </div>
          )}

          {browseError && <p className="text-sm text-destructive">{browseError}</p>}

          {browseLoading && browseKeys.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading documents…
            </div>
          )}

          {browseLoaded && filteredBrowseKeys.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {browseFilter.trim() ? 'No documents match the filter.' : 'No documents found in this index.'}
            </p>
          )}

          {filteredBrowseKeys.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">
                Showing {filteredBrowseKeys.length.toLocaleString()} document{filteredBrowseKeys.length !== 1 ? 's' : ''}
                {browseFilter.trim() ? ` matching "${browseFilter.trim()}"` : ''}
                {!browseDone ? ' (more available)' : ''}
              </p>
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-3 py-1.5 font-medium w-[40px]">#</th>
                      <th className="text-left px-3 py-1.5 font-medium">Key</th>
                      <th className="w-[90px]" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBrowseKeys.map((row, idx) => {
                      const label = getKeyLabel(row.fields, nonVectorFields);
                      return (
                        <Fragment key={row.key}>
                          <tr
                            onClick={() => setBrowseExpanded(prev => toggleInSet(prev, row.key))}
                            className="border-b last:border-0 cursor-pointer hover:bg-muted/30 transition-colors"
                          >
                            <td className="px-3 py-1.5 text-muted-foreground">{idx + 1}</td>
                            <td className="px-3 py-1.5">
                              <span className="flex items-center gap-1">
                                <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${browseExpanded.has(row.key) ? 'rotate-90' : ''}`} />
                                <span className="font-mono text-xs truncate">{row.key}</span>
                              </span>
                              {label && <span className="text-[11px] text-muted-foreground block ml-4 truncate">{label}</span>}
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <button
                                onClick={e => { e.stopPropagation(); handleFindSimilar(row.key); }}
                                className="text-[11px] text-primary hover:text-primary/80 font-medium"
                                title={`Find keys similar to ${row.key}`}
                              >
                                Find similar
                              </button>
                            </td>
                          </tr>
                          {browseExpanded.has(row.key) && (
                            <tr className="border-b last:border-0 bg-muted/20">
                              <td colSpan={3} className="px-3 py-2">
                                <FieldGrid fields={row.fields} fieldMeta={browseFieldMeta} docKey={row.key} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!browseDone && (
                <button
                  onClick={() => loadBrowseKeys(browseCursor)}
                  disabled={browseLoading}
                  className="w-full py-2 text-xs text-primary hover:bg-accent transition-colors flex items-center justify-center gap-1 border rounded-md mt-2"
                >
                  {browseLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  {browseLoading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* === Text Search Tab === */}
      {tab === 'text' && (
        <TextSearchTab info={info} />
      )}

      {/* === Distribution Tab === */}
      {tab === 'distribution' && (
        <DistributionTab info={info} />
      )}

      {/* === Graph Tab === */}
      {tab === 'graph' && (
        <VectorGraphTab info={info} />
      )}

      {/* === Profiler Tab === */}
      {tab === 'profile' && (
        <ProfilerTab info={info} />
      )}
    </div>
  );
}

// --- Text Search Tab ---

function TextSearchTab({ info }: { info: VectorIndexInfo }) {
  const [query, setQuery] = useState('*');
  const [results, setResults] = useState<TextSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const handleSearch = async (newOffset = 0) => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setLatencyMs(null);
    setOffset(newOffset);
    const t0 = performance.now();
    try {
      const res = await metricsApi.textSearch(info.name, { query: query.trim(), offset: newOffset, limit });
      setLatencyMs(Math.round(performance.now() - t0));
      setResults(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const fieldMeta = useMemo(() => buildFieldMeta(results?.results ?? []), [results]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Run full-text queries using FT.SEARCH syntax.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="hello world | @field:{value} | @price:[0 100]"
          className="flex-1 px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono"
          onKeyDown={e => { if (e.key === 'Enter') handleSearch(0); }}
        />
        <button
          onClick={() => handleSearch(0)}
          disabled={loading || !query.trim()}
          className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Search
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground/60">
        Examples: <code className="font-mono">*</code> (all), <code className="font-mono">hello world</code> (text), <code className="font-mono">@tag:{'{'}val{'}'}</code> (tag filter), <code className="font-mono">@num:[0 100]</code> (range)
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {results && (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {latencyMs != null && <><Clock className="w-3 h-3" /><span>{results.totalResults.toLocaleString()} total result{results.totalResults !== 1 ? 's' : ''} in <span className="font-medium text-foreground">{latencyMs} ms</span></span></>}
            {results.totalResults > limit && <span className="ml-2">Showing {offset + 1}–{Math.min(offset + limit, results.totalResults)}</span>}
          </div>

          {results.results.length > 0 && (
            <TextSearchResults results={results.results} fieldMeta={fieldMeta} />
          )}
          {results.results.length === 0 && <p className="text-sm text-muted-foreground">No results found.</p>}

          {results.totalResults > limit && (
            <div className="flex gap-2 justify-center">
              <button
                disabled={offset === 0}
                onClick={() => handleSearch(Math.max(0, offset - limit))}
                className="px-3 py-1 text-xs border rounded-md disabled:opacity-30"
              >
                Previous
              </button>
              <button
                disabled={offset + limit >= results.totalResults}
                onClick={() => handleSearch(offset + limit)}
                className="px-3 py-1 text-xs border rounded-md disabled:opacity-30"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TextSearchResults({ results, fieldMeta }: { results: Array<{ key: string; fields: Record<string, string> }>; fieldMeta: Record<string, FieldMeta> }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return (
    <div className="border rounded-md overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-3 py-1.5 font-medium w-[40px]">#</th>
            <th className="text-left px-3 py-1.5 font-medium">Key</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row, idx) => (
            <Fragment key={row.key}>
              <tr
                onClick={() => setExpanded(prev => toggleInSet(prev, row.key))}
                className="border-b last:border-0 cursor-pointer hover:bg-muted/30 transition-colors"
              >
                <td className="px-3 py-1.5 text-muted-foreground">{idx + 1}</td>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1">
                    <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${expanded.has(row.key) ? 'rotate-90' : ''}`} />
                    <span className="font-mono text-xs truncate">{row.key}</span>
                  </span>
                </td>
              </tr>
              {expanded.has(row.key) && (
                <tr className="border-b last:border-0 bg-muted/20">
                  <td colSpan={2} className="px-3 py-2">
                    <FieldGrid fields={row.fields} fieldMeta={fieldMeta} docKey={row.key} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Distribution Tab ---

function DistributionTab({ info }: { info: VectorIndexInfo }) {
  const nonVectorFields = info.fields.filter(f => f.type !== 'VECTOR');
  const [distributions, setDistributions] = useState<Record<string, FieldDistribution>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const loadDistribution = async (fieldName: string, fieldType: string) => {
    setLoading(prev => new Set(prev).add(fieldName));
    try {
      const dist = await metricsApi.getFieldDistribution(info.name, fieldName, fieldType);
      setDistributions(prev => ({ ...prev, [fieldName]: dist }));
      setErrors(prev => { const n = { ...prev }; delete n[fieldName]; return n; });
    } catch (err) {
      setErrors(prev => ({ ...prev, [fieldName]: err instanceof Error ? err.message : 'Failed' }));
    } finally {
      setLoading(prev => { const n = new Set(prev); n.delete(fieldName); return n; });
    }
  };

  const loadAll = async () => {
    for (const field of nonVectorFields) {
      loadDistribution(field.name, field.type);
    }
  };

  if (nonVectorFields.length === 0) {
    return <p className="text-sm text-muted-foreground">No non-vector fields to analyze.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Value distribution per field using FT.AGGREGATE. Stats computed from up to 100 sampled documents — may not be representative for large indexes.</p>
        <button
          onClick={loadAll}
          className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        >
          Load all
        </button>
      </div>

      <div className="grid gap-3">
        {nonVectorFields.map(field => {
          const dist = distributions[field.name];
          const isLoading = loading.has(field.name);
          const error = errors[field.name];

          return (
            <div key={field.name} className="border rounded-md p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{field.name}</span>
                  <Badge variant="secondary" className="text-[10px]">{field.type}</Badge>
                </div>
                {!dist && !isLoading && (
                  <button
                    onClick={() => loadDistribution(field.name, field.type)}
                    className="text-xs text-primary hover:text-primary/80"
                  >
                    Load
                  </button>
                )}
                {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}

              {dist?.stats && (
                <div className="flex flex-wrap gap-4 text-xs">
                  <span>Min: <span className="font-mono font-medium">{dist.stats.min?.toLocaleString()}</span></span>
                  <span>Max: <span className="font-mono font-medium">{dist.stats.max?.toLocaleString()}</span></span>
                  <span>Avg: <span className="font-mono font-medium">{dist.stats.avg?.toFixed(2)}</span></span>
                  <span>Count: <span className="font-mono font-medium">{dist.stats.count?.toLocaleString()}</span></span>
                </div>
              )}

              {dist?.distribution && dist.distribution.length > 0 && (
                <DistributionBars distribution={dist.distribution} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DistributionBars({ distribution }: { distribution: Array<{ value: string; count: number }> }) {
  const maxCount = Math.max(...distribution.map(d => d.count));
  return (
    <div className="space-y-0.5 mt-1">
      {distribution.slice(0, 20).map(d => (
        <div key={d.value} className="flex items-center gap-2 text-xs">
          <span className="w-24 truncate font-mono text-muted-foreground" title={d.value}>{d.value || '(empty)'}</span>
          <div className="flex-1 h-3 bg-muted rounded overflow-hidden">
            <div className="h-full bg-primary/60 rounded" style={{ width: `${(d.count / maxCount) * 100}%` }} />
          </div>
          <span className="w-12 text-right font-mono">{d.count.toLocaleString()}</span>
        </div>
      ))}
      {distribution.length > 20 && (
        <p className="text-[10px] text-muted-foreground mt-1">Showing top 20 of {distribution.length} values</p>
      )}
    </div>
  );
}

// --- Profiler Tab ---

function ProfilerTab({ info }: { info: VectorIndexInfo }) {
  const [query, setQuery] = useState('*');
  const [limited, setLimited] = useState(false);
  const [result, setResult] = useState<ProfileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleProfile = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await metricsApi.profileSearch(info.name, { query: query.trim(), limited });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Profile failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Profile a search query to see execution timing breakdown using FT.PROFILE.
      </p>
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className="text-xs text-muted-foreground block mb-1">Query</label>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="* | hello | @field:{value}"
            className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono"
            onKeyDown={e => { if (e.key === 'Enter') handleProfile(); }}
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground pb-1.5">
          <input type="checkbox" checked={limited} onChange={e => setLimited(e.target.checked)} className="rounded" />
          LIMITED
        </label>
        <button
          onClick={handleProfile}
          disabled={loading || !query.trim()}
          className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BarChart3 className="w-3.5 h-3.5" />}
          Profile
        </button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {result && (
        <div className="space-y-3">
          {/* Timing summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <TimingCard label="Total Time" ms={result.profile.totalTimeMs} />
            <TimingCard label="Parsing" ms={result.profile.parsingTimeMs} />
            <TimingCard label="Results" count={result.results.totalResults} />
            <TimingCard label="Processors" count={result.profile.resultProcessorsProfile.length} />
          </div>

          {/* Iterator tree */}
          {result.profile.iteratorsProfile && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">Iterator Tree</h4>
              <div className="border rounded-md p-3 bg-muted/20 font-mono text-xs space-y-0.5">
                <IteratorNode node={result.profile.iteratorsProfile} totalMs={result.profile.totalTimeMs} depth={0} />
              </div>
            </div>
          )}

          {/* Result processors */}
          {result.profile.resultProcessorsProfile.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">Result Processors</h4>
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-3 py-1 font-medium">Type</th>
                      <th className="text-right px-3 py-1 font-medium">Time</th>
                      <th className="text-right px-3 py-1 font-medium">Counter</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.profile.resultProcessorsProfile.map((p, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-3 py-1">{p.type}</td>
                        <td className="px-3 py-1 text-right">
                          <TimingBadge ms={p.timeMs} />
                        </td>
                        <td className="px-3 py-1 text-right text-muted-foreground">{p.counter.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TimingCard({ label, ms, count }: { label: string; ms?: number; count?: number }) {
  return (
    <div className="border rounded-md p-2 text-center">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      {ms != null ? (
        <p className="text-lg font-semibold mt-0.5"><TimingBadge ms={ms} large /></p>
      ) : (
        <p className="text-lg font-semibold mt-0.5">{count?.toLocaleString()}</p>
      )}
    </div>
  );
}

function TimingBadge({ ms, large }: { ms: number; large?: boolean }) {
  const color = ms < 1 ? 'text-green-600' : ms < 10 ? 'text-amber-600' : 'text-red-500';
  const size = large ? 'text-lg' : 'text-xs';
  return <span className={`${color} ${size} font-mono`}>{ms.toFixed(2)} ms</span>;
}

function IteratorNode({ node, totalMs, depth }: { node: ProfileIterator; totalMs: number; depth: number }) {
  const pct = totalMs > 0 ? (node.timeMs / totalMs) * 100 : 0;
  return (
    <>
      <div style={{ paddingLeft: depth * 16 }} className="flex items-center gap-2">
        <span className="text-muted-foreground">{depth > 0 ? '└─' : ''}</span>
        <span className="font-medium">{node.type}</span>
        {node.queryType && <span className="text-muted-foreground">({node.queryType})</span>}
        <TimingBadge ms={node.timeMs} />
        {pct > 1 && <span className="text-[10px] text-muted-foreground">{pct.toFixed(0)}%</span>}
        <span className="text-muted-foreground">×{node.counter.toLocaleString()}</span>
      </div>
      {node.childIterators?.map((child, i) => (
        <IteratorNode key={i} node={child} totalMs={totalMs} depth={depth + 1} />
      ))}
    </>
  );
}

// --- Tag value explorer (feature #2) ---

function TagValueExplorer({ indexName, fieldName }: { indexName: string; fieldName: string }) {
  const [values, setValues] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    if (values) { setOpen(!open); return; }
    setLoading(true);
    try {
      const res = await metricsApi.getTagValues(indexName, fieldName);
      setValues(res.values);
      setOpen(true);
    } catch {
      setValues([]);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="inline">
      <button onClick={load} className="text-[10px] text-primary hover:text-primary/80 ml-1">
        {loading ? '...' : open ? 'hide' : 'values'}
      </button>
      {open && values && (
        <span className="flex flex-wrap gap-1 mt-1">
          {values.length === 0 && <span className="text-[10px] text-muted-foreground">No values</span>}
          {values.slice(0, 100).map(v => (
            <Badge key={v} variant="outline" className="text-[10px] px-1 py-0 font-mono">{v}</Badge>
          ))}
          {values.length > 100 && <span className="text-[10px] text-muted-foreground">+{values.length - 100} more</span>}
        </span>
      )}
    </span>
  );
}

// --- Vector Space Graph (Canvas, high-perf) ---

interface GNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number | null;
  fy?: number | null;
  fields: Record<string, string>;
  color: string;
  expanded?: boolean;
  degree: number;
}

interface GEdge {
  source: string;
  target: string;
  score: number;
}

const GRAPH_PALETTE = [
  '#7c3aed', '#db2777', '#d97706', '#059669', '#2563eb',
  '#9333ea', '#e11d48', '#0d9488', '#ea580c', '#0891b2',
  '#65a30d', '#c026d3', '#c2410c', '#0e7490', '#ca8a04',
];

function mkColorMap(nodes: GNode[], field: string) {
  const m = new Map<string, string>();
  if (!field) return m;
  const vals = [...new Set(nodes.map(n => n.fields[field] || '').filter(Boolean))];
  vals.forEach((v, i) => m.set(v, GRAPH_PALETTE[i % GRAPH_PALETTE.length]));
  return m;
}

function VectorGraphTab({ info }: { info: VectorIndexInfo }) {
  const vectorFields = info.fields.filter(f => f.type === 'VECTOR');
  const nonVectorFields = info.fields.filter(f => f.type !== 'VECTOR');

  const [vectorField, setVectorField] = useState(vectorFields[0]?.name ?? '');
  const [colorField, setColorField] = useState(nonVectorFields[0]?.name ?? '');
  const [nodeCount, setNodeCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeVersion, setSelectedNodeVersion] = useState(0);
  const [expanding, setExpanding] = useState(false);
  const [legend, setLegend] = useState<Array<[string, string]>>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // All mutable graph state in a single ref — zero React re-renders during animation
  const gs = useRef({
    nodes: [] as GNode[],
    edges: [] as GEdge[],
    nodeMap: new Map<string, GNode>(),
    colorMap: new Map<string, string>(),
    camX: 0, camY: 0, zoom: 1,
    selected: null as GNode | null,
    hovered: null as GNode | null,
    drag: null as GNode | null,
    panning: false,
    panSX: 0, panSY: 0, camSX: 0, camSY: 0,
    sim: null as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    running: false,
    frame: 0,
    w: 900, h: 600,
    dpr: 1,
  });

  const selectNode = useCallback((node: GNode | null) => {
    gs.current.selected = node;
    setSelectedNodeVersion(v => v + 1);
  }, []);

  const s2w = useCallback((sx: number, sy: number) => {
    const g = gs.current;
    return { x: (sx - g.w / 2) / g.zoom + g.camX, y: (sy - g.h / 2) / g.zoom + g.camY };
  }, []);

  const hit = useCallback((wx: number, wy: number): GNode | null => {
    const arr = gs.current.nodes;
    for (let i = arr.length - 1; i >= 0; i--) {
      const n = arr[i];
      const r = 3 + Math.min(n.degree, 20) * 0.8 + 4;
      const dx = n.x - wx, dy = n.y - wy;
      if (dx * dx + dy * dy < r * r) return n;
    }
    return null;
  }, []);

  // --- Canvas draw ---
  const draw = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const g = gs.current;
    const dpr = g.dpr;
    const w = g.w, h = g.h;

    if (cvs.width !== w * dpr || cvs.height !== h * dpr) {
      cvs.width = w * dpr;
      cvs.height = h * dpr;
      cvs.style.width = w + 'px';
      cvs.style.height = h + 'px';
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = containerRef.current ? getComputedStyle(containerRef.current) : null;
    const bgColor = cs?.getPropertyValue('--background').trim() || '#ffffff';
    const fgColor = cs?.getPropertyValue('--foreground').trim() || '#1e293b';
    const mutedFg = cs?.getPropertyValue('--muted-foreground').trim() || '#94a3b8';
    ctx.fillStyle = `hsl(${bgColor})`;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(g.zoom, g.zoom);
    ctx.translate(-g.camX, -g.camY);

    const sel = g.selected;
    let nbrSet: Set<string> | null = null;
    if (sel) {
      nbrSet = new Set<string>();
      for (const e of g.edges) {
        if (e.source === sel.id) nbrSet.add(e.target);
        if (e.target === sel.id) nbrSet.add(e.source);
      }
    }

    // Edges
    for (const e of g.edges) {
      const sn = g.nodeMap.get(e.source), tn = g.nodeMap.get(e.target);
      if (!sn || !tn) continue;
      const highlighted = sel && (e.source === sel.id || e.target === sel.id);
      ctx.strokeStyle = highlighted ? sel!.color : sn.color;
      ctx.globalAlpha = highlighted ? 0.45 : 0.1 + (1 - Math.min(e.score, 1)) * 0.12;
      ctx.lineWidth = highlighted ? 1.5 : 0.5;
      ctx.beginPath();
      ctx.moveTo(sn.x, sn.y);
      ctx.lineTo(tn.x, tn.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nodes
    for (const n of g.nodes) {
      const r = 3 + Math.min(n.degree, 20) * 0.8;
      const isH = g.hovered?.id === n.id;
      const isS = sel?.id === n.id;
      const isN = nbrSet?.has(n.id);
      const dim = sel && !isS && !isN;

      ctx.save();
      if (!dim) { ctx.shadowColor = n.color; ctx.shadowBlur = isH || isS ? 16 : 6; }
      ctx.globalAlpha = dim ? 0.1 : 0.85;
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, isH || isS ? r * 1.5 : r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (isS) {
        ctx.strokeStyle = `hsl(${fgColor})`;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 1.5 + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (!dim) {
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 0.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const n of g.nodes) {
      const isH = g.hovered?.id === n.id;
      const isS = sel?.id === n.id;
      const show = isH || isS || (n.degree >= 5 && g.zoom > 0.6);
      if (!show) continue;
      const dim = sel && !isS && !nbrSet?.has(n.id);
      if (dim) continue;

      const r = 3 + Math.min(n.degree, 20) * 0.8;
      const lbl = n.id.length > 24 ? n.id.slice(0, 21) + '...' : n.id;
      const fs = Math.max(9, Math.min(12, 10 / g.zoom));
      ctx.font = `${fs}px ui-monospace, monospace`;
      const tw = ctx.measureText(lbl).width;
      const p = 3;
      ctx.fillStyle = `hsl(${bgColor})`;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(n.x - tw / 2 - p, n.y - r * 1.6 - fs - p, tw + p * 2, fs + p * 2);
      ctx.globalAlpha = isH || isS ? 1 : 0.7;
      ctx.fillStyle = `hsl(${fgColor})`;
      ctx.fillText(lbl, n.x, n.y - r * 1.6);
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // HUD
    ctx.fillStyle = `hsl(${mutedFg})`;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${g.nodes.length} nodes \u00b7 ${g.edges.length} edges`, 12, h - 10);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(g.zoom * 100)}%`, w - 12, h - 10);
  }, []);

  const animate = useCallback(() => {
    const g = gs.current;
    if (!g.running) return;
    if (g.sim) g.sim.tick();
    draw();
    g.frame = requestAnimationFrame(animate);
  }, [draw]);

  const startSim = useCallback(() => {
    const g = gs.current;
    g.sim?.stop();
    import('d3').then(d3 => {
      if (!g.running) return;
      const links = g.edges.map(e => ({
        source: g.nodeMap.get(e.source)!, target: g.nodeMap.get(e.target)!, score: e.score,
      })).filter(e => e.source && e.target);

      const sim = d3.forceSimulation(g.nodes)
        .force('link', d3.forceLink(links).id((d: any) => d.id) // eslint-disable-line @typescript-eslint/no-explicit-any
          .distance((e: any) => 20 + (e.score ?? 0.5) * 40).strength(0.7)) // eslint-disable-line @typescript-eslint/no-explicit-any
        .force('charge', d3.forceManyBody().strength(-60).distanceMax(250))
        .force('center', d3.forceCenter(0, 0).strength(0.08))
        .force('collision', d3.forceCollide((d: any) => 3 + Math.min(d.degree || 0, 20) * 0.5)) // eslint-disable-line @typescript-eslint/no-explicit-any
        .alphaDecay(0.05)
        .velocityDecay(0.6)
        .on('tick', () => {});
      g.sim = sim;
      g.camX = 0; g.camY = 0; g.zoom = 1;
    }).catch(err => {
      setError(`Failed to load graph library: ${err instanceof Error ? err.message : 'Unknown error'}`);
    });
  }, []);

  // Build graph
  const buildGraph = useCallback(async () => {
    if (!vectorField) return;
    setLoading(true);
    setError(null);
    selectNode(null);

    const g = gs.current;
    g.hovered = null;
    g.running = false;
    cancelAnimationFrame(g.frame);
    g.sim?.stop();

    try {
      const { keys } = await metricsApi.sampleIndexKeys(info.name, { limit: 40 });
      if (keys.length === 0) { setError('No keys found'); setLoading(false); return; }

      const nodes: GNode[] = keys.map(k => ({
        id: k.key, x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400,
        vx: 0, vy: 0, fields: k.fields, color: '#6b7280', degree: 0,
      }));

      const edgeSet = new Set<string>();
      const edges: GEdge[] = [];
      const search = keys.slice(0, Math.min(20, keys.length));
      const ids = new Set(nodes.map(n => n.id));

      const res = await Promise.allSettled(
        search.map(k => metricsApi.vectorSearch(info.name, { sourceKey: k.key, vectorField, k: 6 }))
      );

      for (let i = 0; i < res.length; i++) {
        if (res[i].status !== 'fulfilled') continue;
        const src = search[i].key;
        for (const m of (res[i] as PromiseFulfilledResult<any>).value.results) { // eslint-disable-line @typescript-eslint/no-explicit-any
          if (m.key === src) continue;
          const ek = [src, m.key].sort().join('||');
          if (edgeSet.has(ek)) continue;
          edgeSet.add(ek);
          if (!ids.has(m.key)) {
            ids.add(m.key);
            nodes.push({ id: m.key, x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400, vx: 0, vy: 0, fields: m.fields, color: '#6b7280', degree: 0 });
          }
          edges.push({ source: src, target: m.key, score: m.score });
        }
      }

      for (const e of edges) {
        const s = nodes.find(n => n.id === e.source), t = nodes.find(n => n.id === e.target);
        if (s) s.degree++;
        if (t) t.degree++;
      }
      const cm = mkColorMap(nodes, colorField);
      for (const n of nodes) n.color = cm.get(n.fields[colorField] || '') || '#6b7280';

      g.nodes = nodes;
      g.edges = edges;
      g.nodeMap = new Map(nodes.map(n => [n.id, n]));
      g.colorMap = cm;
      g.dpr = window.devicePixelRatio || 1;
      g.running = true;

      setNodeCount(nodes.length);

      setLegend([...cm.entries()].slice(0, 12));

      startSim();
      g.frame = requestAnimationFrame(animate);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build graph');
    } finally {
      setLoading(false);
    }
  }, [info.name, vectorField, colorField, startSim, animate]);

  // Expand node
  const expandNode = useCallback(async (node: GNode) => {
    if (!vectorField || expanding) return;
    setExpanding(true);
    try {
      const r = await metricsApi.vectorSearch(info.name, { sourceKey: node.id, vectorField, k: 10 });
      const g = gs.current;
      const exist = new Set(g.nodes.map(n => n.id));
      const existE = new Set(g.edges.map(e => [e.source, e.target].sort().join('||')));

      for (const m of r.results) {
        if (m.key === node.id) continue;
        const ek = [node.id, m.key].sort().join('||');
        if (!existE.has(ek)) { existE.add(ek); g.edges.push({ source: node.id, target: m.key, score: m.score }); node.degree++; }
        if (!exist.has(m.key)) {
          exist.add(m.key);
          const nn: GNode = { id: m.key, x: node.x + (Math.random() - 0.5) * 60, y: node.y + (Math.random() - 0.5) * 60, vx: 0, vy: 0, fields: m.fields, color: g.colorMap.get(m.fields[colorField] || '') || '#6b7280', degree: 1 };
          g.nodes.push(nn);
          g.nodeMap.set(nn.id, nn);
        } else { const ex = g.nodeMap.get(m.key); if (ex) ex.degree++; }
      }
      node.expanded = true;
      setNodeCount(g.nodes.length);
      startSim();
    } catch { /* silent */ } finally { setExpanding(false); }
  }, [info.name, vectorField, colorField, expanding, startSim]);

  // Resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        gs.current.w = Math.round(e.contentRect.width);
        gs.current.h = Math.round(Math.max(e.contentRect.height, 500));
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Mouse handlers
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;

    const onMove = (ev: MouseEvent) => {
      const rect = cvs.getBoundingClientRect();
      const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
      const g = gs.current;

      if (g.drag) {
        const w = s2w(sx, sy);
        g.drag.fx = w.x; g.drag.fy = w.y;
        g.drag.x = w.x; g.drag.y = w.y;
        g.drag.vx = 0; g.drag.vy = 0;
        if (g.sim) g.sim.alpha(0.3).restart();
        return;
      }
      if (g.panning) {
        g.camX = g.camSX - (sx - g.panSX) / g.zoom;
        g.camY = g.camSY - (sy - g.panSY) / g.zoom;
        return;
      }
      const w = s2w(sx, sy);
      g.hovered = hit(w.x, w.y);
      cvs.style.cursor = g.hovered ? 'pointer' : 'grab';
    };

    const onDown = (ev: MouseEvent) => {
      const rect = cvs.getBoundingClientRect();
      const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
      const g = gs.current;
      const w = s2w(sx, sy);
      const h = hit(w.x, w.y);
      if (h) {
        g.drag = h;
        h.fx = h.x; h.fy = h.y;
        if (g.sim) g.sim.alphaTarget(0.3).restart();
      } else {
        g.panning = true;
        g.panSX = sx; g.panSY = sy;
        g.camSX = g.camX; g.camSY = g.camY;
        cvs.style.cursor = 'grabbing';
      }
    };

    const onUp = () => {
      const g = gs.current;
      if (g.drag) {
        g.drag.fx = null; g.drag.fy = null;
        if (g.sim) g.sim.alphaTarget(0);
        g.drag = null;
      }
      if (g.panning) { g.panning = false; cvs.style.cursor = g.hovered ? 'pointer' : 'grab'; }
    };

    const onClick = (ev: MouseEvent) => {
      const rect = cvs.getBoundingClientRect();
      const w = s2w(ev.clientX - rect.left, ev.clientY - rect.top);
      const h = hit(w.x, w.y);
      if (h) {
        selectNode(gs.current.selected?.id === h.id ? null : h);
        if (!h.expanded) expandNode(h);
      } else {
        selectNode(null);
      }
    };

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const g = gs.current;
      const rect = cvs.getBoundingClientRect();
      const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
      const before = s2w(sx, sy);
      g.zoom = Math.max(0.1, Math.min(8, g.zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const after = s2w(sx, sy);
      g.camX -= after.x - before.x;
      g.camY -= after.y - before.y;
    };

    cvs.addEventListener('mousemove', onMove);
    cvs.addEventListener('mousedown', onDown);
    cvs.addEventListener('mouseup', onUp);
    cvs.addEventListener('mouseleave', onUp);
    cvs.addEventListener('click', onClick);
    cvs.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cvs.removeEventListener('mousemove', onMove);
      cvs.removeEventListener('mousedown', onDown);
      cvs.removeEventListener('mouseup', onUp);
      cvs.removeEventListener('mouseleave', onUp);
      cvs.removeEventListener('click', onClick);
      cvs.removeEventListener('wheel', onWheel);
    };
  }, [s2w, hit, expandNode]);

  // Keep animation running
  useEffect(() => {
    if (nodeCount === 0) return;
    const g = gs.current;
    if (!g.running) { g.running = true; g.frame = requestAnimationFrame(animate); }
    return () => { g.running = false; cancelAnimationFrame(g.frame); g.sim?.stop(); };
  }, [nodeCount, animate]);

  // Read from ref — re-evaluated each render (triggered by selectedNodeVersion bumps)
  const selectedNode = gs.current.selected;
  void selectedNodeVersion; // ensure React tracks this dependency

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Visualize vector similarity as a force-directed graph. Scroll to zoom, drag to pan, click nodes to expand neighbors.
        Showing a sample of up to 40 documents from {info.numDocs.toLocaleString()} total.
      </p>
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Vector field</label>
          <select className="px-2 py-1.5 text-sm border rounded-md bg-background" value={vectorField} onChange={e => setVectorField(e.target.value)}>
            {vectorFields.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Color by</label>
          <select className="px-2 py-1.5 text-sm border rounded-md bg-background" value={colorField} onChange={e => setColorField(e.target.value)}>
            <option value="">None</option>
            {nonVectorFields.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
        </div>
        <button onClick={buildGraph} disabled={loading} className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5">
          {loading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Building...</> : nodeCount > 0 ? 'Rebuild' : 'Build Graph'}
        </button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div ref={containerRef} className="rounded-lg overflow-hidden relative border bg-background" style={{ height: 600 }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', cursor: 'grab' }} />
        {legend.length > 0 && (
          <div className="absolute top-3 right-3 rounded-lg px-3 py-2 text-[11px] space-y-1 max-w-[180px] shadow-md bg-card/95 border">
            <div className="font-medium text-muted-foreground mb-1.5 text-[10px] uppercase tracking-wider">{colorField}</div>
            {legend.map(([v, c]) => (
              <div key={v} className="flex items-center gap-2 truncate">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: c, boxShadow: `0 0 4px ${c}` }} />
                <span className="truncate text-foreground">{v}</span>
              </div>
            ))}
          </div>
        )}
        {selectedNode && (
          <div className="absolute bottom-3 left-3 rounded-lg px-4 py-3 text-xs max-w-[350px] shadow-lg bg-card/95 border">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono font-medium text-foreground truncate mr-3 text-[13px]">{selectedNode.id}</span>
              <button onClick={() => selectNode(null)} className="text-muted-foreground hover:text-foreground transition-colors"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-1 max-h-[140px] overflow-y-auto pr-1">
              {Object.entries(selectedNode.fields).slice(0, 15).map(([k, v]) => (
                <div key={k} className="flex gap-2"><span className="text-muted-foreground flex-shrink-0">{k}</span><span className="truncate font-mono text-foreground">{v}</span></div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-2 pt-2 text-[10px] text-muted-foreground border-t">
              <span>{selectedNode.degree} connections</span>
              {expanding && <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Expanding...</span>}
              {selectedNode.expanded && !expanding && <span>Expanded</span>}
            </div>
          </div>
        )}
        {nodeCount === 0 && !loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center"><div className="text-muted-foreground text-sm mb-2">Click &ldquo;Build Graph&rdquo; to visualize the vector space</div><div className="text-muted-foreground/60 text-xs">Nodes represent keys, edges show vector similarity</div></div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Config Inspector (feature #5) ---

function SearchConfigCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="pb-0">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          Search Module Configuration
        </button>
      </CardHeader>
      {open && (
        <CardContent className="pt-3">
          <SearchConfigPanel />
        </CardContent>
      )}
    </Card>
  );
}

function SearchConfigPanel() {
  const [config, setConfig] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await metricsApi.getSearchConfig();
      setConfig(res.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading && !config) return <div className="flex items-center gap-2 text-sm text-muted-foreground py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading config...</div>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!config) return null;
  if (Object.keys(config).length === 0) return <p className="text-sm text-muted-foreground py-2">Search configuration is not available on this server.</p>;

  const entries = Object.entries(config).filter(([k]) =>
    !filter || k.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter settings..."
        className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background"
      />
      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-3 py-1.5 font-medium">Setting</th>
              <th className="text-left px-3 py-1.5 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} className="border-b last:border-0">
                <td className="px-3 py-1 font-mono">{k}</td>
                <td className="px-3 py-1 font-mono text-muted-foreground">{v}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={2} className="px-3 py-3 text-center text-muted-foreground">No matching settings</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Prefix breakdown for browse tab (feature #6) ---

function PrefixBreakdown({ keys, prefixes }: { keys: Array<{ key: string }>; prefixes: string[] }) {
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const prefix of prefixes) map[prefix] = 0;
    for (const { key } of keys) {
      for (const prefix of prefixes) {
        if (key.startsWith(prefix)) { map[prefix]++; break; }
      }
    }
    return map;
  }, [keys, prefixes]);

  return (
    <div className="flex flex-wrap gap-2 mt-1.5">
      {prefixes.map(prefix => (
        <span key={prefix} className="text-[10px] px-1.5 py-0.5 border rounded bg-muted/50">
          <span className="font-mono">{prefix}*</span>
          <span className="ml-1 text-muted-foreground">{counts[prefix] ?? 0}</span>
        </span>
      ))}
    </div>
  );
}

// --- Shared components ---

function StatItem({ label, value, tooltip }: { label: string; value: React.ReactNode; tooltip?: string }) {
  return (
    <div className="min-w-[80px]" title={tooltip}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <p className="font-semibold text-base">{value}</p>
    </div>
  );
}

function StatusBadge({ info }: { info: VectorIndexInfo }) {
  if (info.indexingFailures > 0) {
    return <Badge variant="warning">{info.indexingFailures} failures</Badge>;
  }
  if (info.percentIndexed >= 100 && info.indexingState === 'indexed') {
    return <Badge variant="success">Indexed</Badge>;
  }
  return <Badge variant="warning">Indexing {Math.round(info.percentIndexed)}%</Badge>;
}

// --- Semantic cache detection ---

const SEMANTIC_CACHE_INDEX_NAMES = ['llmcache', 'semantic_cache', 'semanticcache', 'betterdb_memory', 'llm_cache'];
const CACHE_NAME_RE = /cache|llm|semantic/i;
const SEMANTIC_CACHE_VECTOR_FIELDS = ['embedding', 'embeddings', 'vector_field', 'content_vector', 'text_embedding'];

function isSemanticCache(info: VectorIndexInfo): boolean {
  const nameLower = info.name.toLowerCase();
  if (SEMANTIC_CACHE_INDEX_NAMES.some(n => nameLower === n)) return true;
  // Only match on vector field names if the index name also hints at caching
  if (!CACHE_NAME_RE.test(info.name)) return false;
  return info.fields.some(
    f => f.type === 'VECTOR' && SEMANTIC_CACHE_VECTOR_FIELDS.includes(f.name.toLowerCase()),
  );
}

// --- Insight evaluation ---

interface Insight {
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  docUrl: string;
  docLabel: string;
  copyCommand?: { text: string; label: string };
}

function getInsights(info: VectorIndexInfo): Insight[] {
  const insights: Insight[] = [];
  const vectorField = info.fields.find(f => f.type === 'VECTOR');

  // 1. Indexing failures (error) — check first, most critical
  if (info.indexingFailures > 0) {
    const s = info.indexingFailures === 1 ? '' : 's';
    insights.push({
      severity: 'error',
      title: `${info.indexingFailures.toLocaleString()} document${s} failed to index`,
      description: `These documents were skipped silently. The most common cause is a mismatch between the document's field types and the index schema \u2014 for example, a field expected to be NUMERIC containing a string value. Run FT.INFO in your Valkey CLI to see the full failure details.`,
      docUrl: 'https://valkey.io/topics/search/',
      docLabel: 'Indexing troubleshooting',
      copyCommand: { text: `FT.INFO ${info.name}`, label: 'Copy diagnostic command' },
    });
  }

  // 2. Index fragmentation (warning)
  if (info.numDocs > 0 && info.numRecords > info.numDocs * 2) {
    const ratio = (info.numRecords / info.numDocs).toFixed(1);
    const dropAndCreate = `# Step 1: Drop the index (data is preserved)\nFT.DROPINDEX ${info.name}\n\n# Step 2: Recreate (this triggers a full backfill)\n${buildFtCreateCommand(info)}`;
    insights.push({
      severity: 'warning',
      title: 'Index fragmentation detected',
      description: `This index has ${info.numRecords.toLocaleString()} records for ${info.numDocs.toLocaleString()} documents \u2014 a ${ratio}x ratio. High fragmentation wastes memory and can slow down queries. To resolve fragmentation, drop and recreate the index with \`FT.DROPINDEX ${info.name}\` followed by \`FT.CREATE\`. Note: this will trigger a full reindex backfill.`,
      docUrl: 'https://valkey.io/commands/ft.dropindex/',
      docLabel: 'FT.DROPINDEX docs',
      copyCommand: { text: dropAndCreate, label: 'Copy commands' },
    });
  }

  // 3. FLAT algorithm with large dataset (warning)
  if (vectorField?.algorithm === 'FLAT' && info.numDocs > 10000) {
    const hnswTemplate = `# Adjust M and EF_CONSTRUCTION for your recall/speed tradeoff\n${buildFtCreateCommand(info, { forceHnsw: true })}`;
    insights.push({
      severity: 'warning',
      title: 'FLAT index may be slow at this scale',
      description: `FLAT (brute-force) search examines every vector on every query. With ${info.numDocs.toLocaleString()} documents this may cause high query latency. HNSW (Hierarchical Navigable Small World) offers much faster approximate nearest-neighbor search at this scale.`,
      docUrl: 'https://valkey.io/commands/ft.create/',
      docLabel: 'HNSW vs FLAT',
      copyCommand: { text: hnswTemplate, label: 'Copy HNSW template' },
    });
  }

  // 4. Indexing in progress (info)
  if (info.percentIndexed < 100) {
    insights.push({
      severity: 'info',
      title: 'Index is still building',
      description: `${Math.round(info.percentIndexed)}% of documents have been indexed. Queries will return incomplete results until indexing finishes. Large indexes can take several minutes to build.`,
      docUrl: 'https://valkey.io/topics/search/',
      docLabel: 'How indexing works',
    });
  }

  // 5. High dimension with large dataset (info)
  const dim = vectorField?.dimension;
  if (dim != null && dim > 1536 && info.numDocs > 50000) {
    const perVectorKb = (dim * 4 / 1024).toFixed(1);
    const estimatedMb = (dim * 4 * info.numDocs / (1024 * 1024)).toFixed(0);
    insights.push({
      severity: 'info',
      title: 'High-dimension vectors at scale',
      description: `${dim}-dimension vectors with ${info.numDocs.toLocaleString()} documents require significant memory. Each vector takes approximately ${perVectorKb} KB. Estimated vector storage: ~${estimatedMb} MB.`,
      docUrl: 'https://valkey.io/commands/ft.create/',
      docLabel: 'Vector memory planning',
    });
  }

  // 6. Semantic cache without TTLs (warning)
  if (isSemanticCache(info) && info.numDocs > 1000) {
    insights.push({
      severity: 'warning',
      title: 'Semantic cache may be missing TTLs',
      description: `Semantic caches should set a TTL on every document to prevent unbounded memory growth. This index has ${info.numDocs.toLocaleString()} documents — if cached responses have no expiry, the index will grow until eviction pressure hits. Set a TTL when storing cache entries (e.g. EX 3600 in your application code).`,
      docUrl: 'https://valkey.io/commands/expire/',
      docLabel: 'EXPIRE docs',
    });
  }

  return insights;
}

// --- Formatters ---

function formatMemory(mb: number): string {
  if (mb === 0) return 'N/A';
  if (mb < 0.01) return '< 0.01 MB';
  return `${mb.toFixed(2)} MB`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
