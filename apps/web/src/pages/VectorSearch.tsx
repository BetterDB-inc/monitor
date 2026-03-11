import { useState, useCallback, useRef, useEffect, Fragment } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { InsightCallout } from '../components/InsightCallout';
import { Search, ChevronDown, ChevronUp, ChevronRight, CheckCircle, Loader2 } from 'lucide-react';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { useCapabilities } from '../hooks/useCapabilities';
import { metricsApi } from '../api/metrics';
import type { VectorIndexInfo, VectorIndexField, VectorSearchResult } from '../types/metrics';

interface PollingData {
  indexes: string[];
  details: VectorIndexInfo[];
}

export function VectorSearch() {
  const { currentConnection } = useConnection();
  const { hasVectorSearch } = useCapabilities();

  const fetchIndexes = useCallback(async (signal?: AbortSignal): Promise<PollingData> => {
    const { indexes } = await metricsApi.getVectorIndexList(signal);

    if (indexes.length === 0) {
      return { indexes, details: [] };
    }

    try {
      const details = await Promise.all(
        indexes.map(name => metricsApi.getVectorIndexInfo(name))
      );
      return { indexes, details };
    } catch {
      return { indexes, details: [] };
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
              <IndexCard key={info.name} info={info} />
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

function IndexCard({ info }: { info: VectorIndexInfo }) {
  const [showDetails, setShowDetails] = useState(false);
  const insights = getInsights(info);
  const vectorField = info.fields.find(f => f.type === 'VECTOR');

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold truncate">{info.name}</CardTitle>
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
          <StatItem label="Memory" value={formatMemory(info.memorySizeMb)} />
        </div>

        {/* Insight callouts */}
        {insights.length > 0 ? (
          <div className="space-y-2">
            {insights.map((insight, i) => (
              <InsightCallout key={i} {...insight} />
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

function FieldGrid({ fields }: { fields: Record<string, string> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No fields returned</p>;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2 min-w-0">
          <span className="text-muted-foreground shrink-0">{k}:</span>
          <span className="truncate font-mono">{v}</span>
        </div>
      ))}
    </div>
  );
}

// --- Search tester ---

type SearchTab = 'similar' | 'browse';

function SearchTester({ info }: { info: VectorIndexInfo }) {
  const vectorFields = info.fields.filter(f => f.type === 'VECTOR');
  const nonVectorFields = info.fields.filter(f => f.type !== 'VECTOR');

  const [tab, setTab] = useState<SearchTab>('similar');

  // --- Shared ---
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

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
  const pickerRef = useRef<HTMLDivElement>(null);

  // --- Browse state ---
  const [browseFilter, setBrowseFilter] = useState('');
  const [browseKeys, setBrowseKeys] = useState<Array<{ key: string; fields: Record<string, string> }>>([]);
  const [browseCursor, setBrowseCursor] = useState('0');
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseDone, setBrowseDone] = useState(false);
  const [browseLoaded, setBrowseLoaded] = useState(false);

  if (vectorFields.length === 0) return null;

  const searchedField = info.fields.find(f => f.name === vectorField);
  const isCosine = searchedField?.distanceMetric?.toUpperCase() === 'COSINE';

  const filterableFields = nonVectorFields;
  const filterPlaceholder = filterableFields.length > 0
    ? `@${filterableFields[0].name}:{value}`
    : '@field:{value}';

  // --- Key picker ---
  const loadPickerKeys = async (cursor: string) => {
    setPickerLoading(true);
    try {
      const { keys, cursor: nextCursor } = await metricsApi.sampleIndexKeys(info.name, { cursor, limit: 50 });
      setPickerKeys(prev => cursor === '0' ? keys : [...prev, ...keys]);
      setPickerCursor(nextCursor);
      setPickerDone(nextCursor === '0');
    } catch {
      // silently fail — picker is best-effort
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
    setExpandedRows(new Set());
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
    setBrowseLoading(true);
    try {
      const { keys, cursor: nextCursor } = await metricsApi.sampleIndexKeys(info.name, { cursor, limit: 100 });
      setBrowseKeys(prev => cursor === '0' ? keys : [...prev, ...keys]);
      setBrowseCursor(nextCursor);
      setBrowseDone(nextCursor === '0');
      setBrowseLoaded(true);
    } catch {
      // best-effort
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
        <button className={tabClass('similar')} onClick={() => setTab('similar')}>Find Similar</button>
        <button className={tabClass('browse')} onClick={() => setTab('browse')}>Browse</button>
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
                  {pickerKeys.length === 0 && !pickerLoading && (
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
                    <Fragment key={idx}>
                      <tr
                        onClick={() => setExpandedRows(prev => toggleInSet(prev, idx))}
                        className="border-b last:border-0 cursor-pointer hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-3 py-1.5 text-muted-foreground">{idx + 1}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">
                          <span className="flex items-center gap-1">
                            <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${expandedRows.has(idx) ? 'rotate-90' : ''}`} />
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
                      {expandedRows.has(idx) && (
                        <tr className="border-b last:border-0 bg-muted/20">
                          <td colSpan={4} className="px-3 py-2">
                            <FieldGrid fields={result.fields} />
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
                            onClick={() => setExpandedRows(prev => toggleInSet(prev, idx))}
                            className="border-b last:border-0 cursor-pointer hover:bg-muted/30 transition-colors"
                          >
                            <td className="px-3 py-1.5 text-muted-foreground">{idx + 1}</td>
                            <td className="px-3 py-1.5">
                              <span className="flex items-center gap-1">
                                <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${expandedRows.has(idx) ? 'rotate-90' : ''}`} />
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
                          {expandedRows.has(idx) && (
                            <tr className="border-b last:border-0 bg-muted/20">
                              <td colSpan={3} className="px-3 py-2">
                                <FieldGrid fields={row.fields} />
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

function StatItem({ label, value, tooltip }: { label: string; value: string; tooltip?: string }) {
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

// --- Insight evaluation ---

interface Insight {
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  docUrl: string;
  docLabel: string;
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
      description: `These documents were skipped silently. The most common cause is a mismatch between the document's field types and the index schema \u2014 for example, a field expected to be NUMERIC containing a string value.`,
      docUrl: 'https://valkey.io/topics/search/',
      docLabel: 'Indexing troubleshooting',
    });
  }

  // 2. Index fragmentation (warning)
  if (info.numDocs > 0 && info.numRecords > info.numDocs * 2) {
    const ratio = (info.numRecords / info.numDocs).toFixed(1);
    insights.push({
      severity: 'warning',
      title: 'Index fragmentation detected',
      description: `This index has ${info.numRecords.toLocaleString()} records for ${info.numDocs.toLocaleString()} documents \u2014 a ${ratio}x ratio. High fragmentation wastes memory and can slow down queries. To resolve fragmentation, drop and recreate the index with \`FT.DROPINDEX ${info.name}\` followed by \`FT.CREATE\`. Note: this will trigger a full reindex backfill.`,
      docUrl: 'https://valkey.io/commands/ft.dropindex/',
      docLabel: 'FT.DROPINDEX docs',
    });
  }

  // 3. FLAT algorithm with large dataset (warning)
  if (vectorField?.algorithm === 'FLAT' && info.numDocs > 10000) {
    insights.push({
      severity: 'warning',
      title: 'FLAT index may be slow at this scale',
      description: `FLAT (brute-force) search examines every vector on every query. With ${info.numDocs.toLocaleString()} documents this may cause high query latency. HNSW (Hierarchical Navigable Small World) offers much faster approximate nearest-neighbor search at this scale.`,
      docUrl: 'https://valkey.io/commands/ft.create/',
      docLabel: 'HNSW vs FLAT',
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

  return insights;
}

// --- Formatters ---

function formatMemory(mb: number): string {
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
