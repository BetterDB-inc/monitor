import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { InsightCallout } from '../components/InsightCallout';
import { Search, ChevronDown, ChevronUp, ChevronRight, CheckCircle, Loader2 } from 'lucide-react';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { useCapabilities } from '../hooks/useCapabilities';
import { metricsApi } from '../api/metrics';
import type { VectorIndexInfo, VectorIndexField, VectorSearchResult, VectorIndexSnapshot } from '../types/metrics';

interface PollingData {
  indexes: string[];
  details: VectorIndexInfo[];
  usedMemoryBytes: number;
}

export function VectorSearch() {
  const { currentConnection } = useConnection();
  const { hasVectorSearch } = useCapabilities();

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

function Sparkline({ snapshots }: { snapshots: VectorIndexSnapshot[] }) {
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

  return (
    <div className="min-w-[80px]">
      <span className="text-muted-foreground text-xs">docs / 24h</span>
      <svg width={w} height={h} className="block mt-0.5">
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
      </svg>
    </div>
  );
}

function IndexCard({ info, usedMemoryBytes }: { info: VectorIndexInfo; usedMemoryBytes: number }) {
  const [showDetails, setShowDetails] = useState(false);
  const [snapshots, setSnapshots] = useState<VectorIndexSnapshot[] | null>(null);
  const insights = getInsights(info);
  const vectorField = info.fields.find(f => f.type === 'VECTOR');
  const semanticCache = isSemanticCache(info);

  useEffect(() => {
    metricsApi.getVectorIndexSnapshots(info.name, 24)
      .then(res => setSnapshots(res.snapshots))
      .catch(() => { /* ignore */ });
  }, [info.name]);

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
          {snapshots && <Sparkline snapshots={snapshots} />}
        </div>

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
                      <FieldDetails field={field} />
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

function FieldDetails({ field }: { field: VectorIndexField }) {
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

  if (parts.length === 0 && badges.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      {parts.length > 0 && <span>{parts.join(' \u00b7 ')}</span>}
      {badges.map(b => (
        <Badge key={b} variant="outline" className="text-[10px] px-1 py-0">{b}</Badge>
      ))}
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

type SearchTab = 'similar' | 'browse';

function SearchTester({ info }: { info: VectorIndexInfo }) {
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
    try {
      const { results: res } = await metricsApi.vectorSearch(info.name, {
        sourceKey: key,
        vectorField,
        k,
        filter: filter.trim() || undefined,
      });
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
      <div className="flex gap-1 border-b">
        <button className={tabClass('browse')} onClick={() => setTab('browse')}>Browse</button>
        <button className={tabClass('similar')} onClick={() => setTab('similar')}>Find Similar</button>
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
              />
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
const SEMANTIC_CACHE_VECTOR_FIELDS = ['embedding', 'embeddings', 'vector_field', 'content_vector', 'text_embedding'];

function isSemanticCache(info: VectorIndexInfo): boolean {
  const nameLower = info.name.toLowerCase();
  if (SEMANTIC_CACHE_INDEX_NAMES.some(n => nameLower === n)) return true;
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
