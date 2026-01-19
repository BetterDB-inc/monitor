import { useState, useMemo, useRef, useEffect } from 'react';
import { keyAnalyticsApi } from '../api/keyAnalytics';
import { usePolling } from '../hooks/usePolling';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { BarChart3 } from 'lucide-react';

type SortField = 'pattern' | 'keyCount' | 'memoryBytes' | 'staleKeyCount';
type SortDirection = 'asc' | 'desc';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
  return num.toString();
}

function formatTime(seconds?: number): string {
  if (!seconds) return 'N/A';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

const COLORS = ['hsl(var(--primary))', 'hsl(var(--secondary))', '#82ca9d', '#ffc658', '#ff8042', '#8884d8'];

export function KeyAnalytics() {
  const [sortField, setSortField] = useState<SortField>('keyCount');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [selectedPattern, setSelectedPattern] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // Scroll to detail panel when a pattern is selected
  useEffect(() => {
    if (selectedPattern && detailRef.current) {
      setTimeout(() => {
        detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
    }
  }, [selectedPattern]);

  const { data: summary, loading: _summaryLoading, refresh: refetchSummary } = usePolling({
    fetcher: () => keyAnalyticsApi.getSummary(),
    interval: 60000, // 1 minute
  });

  const { data: patterns, loading: patternsLoading } = usePolling({
    fetcher: () => keyAnalyticsApi.getPatterns({ limit: 100 }),
    interval: 60000,
  });

  const [isCollecting, setIsCollecting] = useState(false);

  const handleTriggerCollection = async () => {
    setIsCollecting(true);
    try {
      await keyAnalyticsApi.triggerCollection();
      setTimeout(() => {
        refetchSummary();
        setIsCollecting(false);
      }, 2000);
    } catch (error) {
      console.error('Failed to trigger collection:', error);
      setIsCollecting(false);
    }
  };

  const sortedPatterns = useMemo(() => {
    if (!patterns) return [];

    const sorted = [...patterns].sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sortField) {
        case 'pattern':
          return sortDirection === 'asc'
            ? a.pattern.localeCompare(b.pattern)
            : b.pattern.localeCompare(a.pattern);
        case 'keyCount':
          aVal = a.keyCount;
          bVal = b.keyCount;
          break;
        case 'memoryBytes':
          aVal = a.totalMemoryBytes;
          bVal = b.totalMemoryBytes;
          break;
        case 'staleKeyCount':
          aVal = a.staleKeyCount || 0;
          bVal = b.staleKeyCount || 0;
          break;
        default:
          return 0;
      }
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return sorted;
  }, [patterns, sortField, sortDirection]);

  const topPatternsByKeys = useMemo(() => {
    if (!patterns) return [];
    return [...patterns]
      .sort((a, b) => b.keyCount - a.keyCount)
      .slice(0, 10)
      .map(p => ({
        name: p.pattern.length > 20 ? p.pattern.substring(0, 20) + '...' : p.pattern,
        fullName: p.pattern,
        value: p.keyCount,
      }));
  }, [patterns]);

  const topPatternsByMemory = useMemo(() => {
    if (!patterns) return [];
    return [...patterns]
      .sort((a, b) => b.totalMemoryBytes - a.totalMemoryBytes)
      .slice(0, 10)
      .map(p => ({
        name: p.pattern.length > 20 ? p.pattern.substring(0, 20) + '...' : p.pattern,
        fullName: p.pattern,
        value: p.totalMemoryBytes,
      }));
  }, [patterns]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return '⇅';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Key Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Analyze key patterns, memory usage, and identify optimization opportunities
          </p>
        </div>
        <button
          onClick={handleTriggerCollection}
          disabled={isCollecting}
          className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 text-sm"
        >
          {isCollecting ? 'Collecting...' : 'Trigger Collection'}
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Total Keys</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary ? formatNumber(summary.totalKeys) : '0'}</div>
            <div className="text-xs text-muted-foreground mt-1">
              across {summary?.totalPatterns || 0} patterns
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Total Memory</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary ? formatBytes(summary.totalMemoryBytes) : '0 B'}</div>
            <div className="text-xs text-muted-foreground mt-1">
              avg {summary ? formatBytes(Math.round(summary.totalMemoryBytes / (summary.totalKeys || 1))) : '0 B'}/key
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Stale Keys</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{summary ? formatNumber(summary.staleKeyCount) : '0'}</div>
            <div className="text-xs text-muted-foreground mt-1">
              idle &gt; 24 hours
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Expiring Soon</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{summary ? formatNumber(summary.keysExpiringSoon) : '0'}</div>
            <div className="text-xs text-muted-foreground mt-1">
              TTL &lt; 1 hour
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Patterns by Key Count */}
        <Card>
          <CardHeader>
            <CardTitle>Top Patterns by Key Count</CardTitle>
          </CardHeader>
          <CardContent>
            {topPatternsByKeys.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={topPatternsByKeys}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" angle={-45} textAnchor="end" height={100} />
                  <YAxis />
                  <Tooltip
                    formatter={(value: number | undefined, _name: string | undefined, props: any) => [formatNumber(value || 0), props.payload.fullName]}
                  />
                  <Bar dataKey="value" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-12 text-muted-foreground">No pattern data available</div>
            )}
          </CardContent>
        </Card>

        {/* Top Patterns by Memory */}
        <Card>
          <CardHeader>
            <CardTitle>Top Patterns by Memory Usage</CardTitle>
          </CardHeader>
          <CardContent>
            {topPatternsByMemory.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={topPatternsByMemory}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={(entry) => `${entry.name}: ${formatBytes(entry.value)}`}
                  >
                    {topPatternsByMemory.map((_entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number | undefined) => formatBytes(value || 0)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-12 text-muted-foreground">No pattern data available</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pattern Table */}
      <Card>
        <CardHeader>
          <CardTitle>Key Patterns</CardTitle>
        </CardHeader>
        <CardContent>
          {patternsLoading ? (
            <div className="text-center py-12">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" role="status">
                <span className="!absolute !-m-px !h-px !w-px !overflow-hidden !whitespace-nowrap !border-0 !p-0 ![clip:rect(0,0,0,0)]">Loading...</span>
              </div>
            </div>
          ) : sortedPatterns.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th
                      className="text-left p-2 cursor-pointer hover:bg-muted"
                      onClick={() => handleSort('pattern')}
                    >
                      Pattern {getSortIcon('pattern')}
                    </th>
                    <th
                      className="text-left p-2 cursor-pointer hover:bg-muted"
                      onClick={() => handleSort('keyCount')}
                    >
                      Key Count {getSortIcon('keyCount')}
                    </th>
                    <th className="text-left p-2">Sampled</th>
                    <th
                      className="text-left p-2 cursor-pointer hover:bg-muted"
                      onClick={() => handleSort('memoryBytes')}
                    >
                      Total Memory {getSortIcon('memoryBytes')}
                    </th>
                    <th className="text-left p-2">Avg Memory</th>
                    <th className="text-left p-2">w/ TTL</th>
                    <th className="text-left p-2">Avg Idle</th>
                    <th
                      className="text-left p-2 cursor-pointer hover:bg-muted"
                      onClick={() => handleSort('staleKeyCount')}
                    >
                      Stale {getSortIcon('staleKeyCount')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPatterns.map((pattern) => (
                    <tr
                      key={pattern.id}
                      className={`border-b hover:bg-muted cursor-pointer transition-colors ${selectedPattern === pattern.pattern ? 'bg-primary/10 border-l-4 border-l-primary' : ''
                        }`}
                      onClick={() => setSelectedPattern(pattern.pattern)}
                    >
                      <td className="p-2 font-mono text-xs">{pattern.pattern}</td>
                      <td className="p-2 font-bold">{formatNumber(pattern.keyCount)}</td>
                      <td className="p-2 text-muted-foreground">{formatNumber(pattern.sampledKeyCount)}</td>
                      <td className="p-2">{formatBytes(pattern.totalMemoryBytes)}</td>
                      <td className="p-2">{formatBytes(pattern.avgMemoryBytes)}</td>
                      <td className="p-2">{formatNumber(pattern.keysWithTtl)}</td>
                      <td className="p-2">{formatTime(pattern.avgIdleTimeSeconds)}</td>
                      <td className={`p-2 ${(pattern.staleKeyCount || 0) > 0 ? 'text-amber-600 font-semibold' : ''}`}>
                        {formatNumber(pattern.staleKeyCount || 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No pattern data available. Click "Trigger Collection" to analyze keys.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pattern Detail (if selected) */}
      {selectedPattern && (
        <Card ref={detailRef} className="animate-in slide-in-from-top-2 duration-300">
          <CardHeader className="bg-primary/5">
            <div className="flex justify-between items-center">
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-primary" />
                Pattern Detail: <span className="font-mono text-sm">{selectedPattern}</span>
              </CardTitle>
              <button
                onClick={() => setSelectedPattern(null)}
                className="text-xs px-3 py-1.5 bg-muted rounded hover:bg-muted/80 transition-colors"
              >
                Close
              </button>
            </div>
          </CardHeader>
          <CardContent>
            {(() => {
              const pattern = sortedPatterns.find(p => p.pattern === selectedPattern);
              if (!pattern) return null;

              return (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-muted-foreground">Key Count</div>
                    <div className="text-lg font-bold">{formatNumber(pattern.keyCount)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Total Memory</div>
                    <div className="text-lg font-bold">{formatBytes(pattern.totalMemoryBytes)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Avg Memory/Key</div>
                    <div className="text-lg font-bold">{formatBytes(pattern.avgMemoryBytes)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Max Memory</div>
                    <div className="text-lg font-bold">{formatBytes(pattern.maxMemoryBytes)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Keys with TTL</div>
                    <div className="text-lg font-bold">{formatNumber(pattern.keysWithTtl)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Expiring Soon</div>
                    <div className="text-lg font-bold text-red-600">{formatNumber(pattern.keysExpiringSoon)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Avg Idle Time</div>
                    <div className="text-lg font-bold">{formatTime(pattern.avgIdleTimeSeconds)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Stale Keys</div>
                    <div className="text-lg font-bold text-amber-600">{formatNumber(pattern.staleKeyCount || 0)}</div>
                  </div>
                  {pattern.avgAccessFrequency !== undefined && pattern.avgAccessFrequency !== null && (
                    <>
                      <div>
                        <div className="text-xs text-muted-foreground">Avg Access Freq</div>
                        <div className="text-lg font-bold">{pattern.avgAccessFrequency.toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Hot Keys</div>
                        <div className="text-lg font-bold text-red-600">{formatNumber(pattern.hotKeyCount || 0)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Cold Keys</div>
                        <div className="text-lg font-bold text-blue-600">{formatNumber(pattern.coldKeyCount || 0)}</div>
                      </div>
                    </>
                  )}
                  {pattern.avgTtlSeconds !== undefined && pattern.avgTtlSeconds !== null && (
                    <>
                      <div>
                        <div className="text-xs text-muted-foreground">Avg TTL</div>
                        <div className="text-lg font-bold">{formatTime(pattern.avgTtlSeconds)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Min TTL</div>
                        <div className="text-lg font-bold">{formatTime(pattern.minTtlSeconds)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Max TTL</div>
                        <div className="text-lg font-bold">{formatTime(pattern.maxTtlSeconds)}</div>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
