import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { metricsApi } from '../api/metrics';
import { DateRangePicker, DateRange } from '../components/ui/date-range-picker';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  TrendingUp,
  TrendingDown,
  Activity,
  Clock,
  ChevronDown,
  ChevronRight,
  Zap,
  Database,
  Users,
  Shield,
  HardDrive,
  AlertOctagon,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from 'recharts';

interface AnomalyEvent {
  id: string;
  timestamp: number;
  metricType: string;
  anomalyType: 'spike' | 'drop';
  severity: 'info' | 'warning' | 'critical';
  value: number;
  baseline: number;
  zScore: number;
  message: string;
  correlationId?: string;
}

interface CorrelatedGroup {
  correlationId: string;
  timestamp: number;
  pattern: string;
  diagnosis: string;
  recommendations: string[];
  severity: 'info' | 'warning' | 'critical';
  anomalies: AnomalyEvent[];
}

interface AnomalySummary {
  totalEvents: number;
  totalGroups: number;
  bySeverity: Record<string, number>;
  byMetric: Record<string, number>;
  byPattern: Record<string, number>;
  activeEvents: number;
  resolvedEvents: number;
}

const SEVERITY_CONFIG = {
  critical: { color: 'text-destructive', bg: 'bg-destructive/10', border: 'border-destructive', icon: AlertCircle },
  warning: { color: 'text-yellow-500', bg: 'bg-yellow-500/10', border: 'border-yellow-500', icon: AlertTriangle },
  info: { color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary', icon: Info },
};

const PATTERN_CONFIG: Record<string, { icon: typeof Activity; label: string; color: string }> = {
  traffic_burst: { icon: TrendingUp, label: 'Traffic Burst', color: 'var(--chart-1)' },
  batch_job: { icon: Database, label: 'Batch Job', color: 'var(--chart-2)' },
  memory_pressure: { icon: HardDrive, label: 'Memory Pressure', color: 'var(--destructive)' },
  slow_queries: { icon: Clock, label: 'Slow Queries', color: 'var(--chart-warning)' },
  auth_attack: { icon: Shield, label: 'Auth Anomaly', color: 'var(--destructive)' },
  connection_leak: { icon: Users, label: 'Connection Leak', color: 'var(--chart-3)' },
  cache_thrashing: { icon: Zap, label: 'Cache Thrashing', color: 'var(--chart-warning)' },
  node_failover: { icon: AlertOctagon, label: 'Node Failover', color: 'var(--destructive)' },
  unknown: { icon: Activity, label: 'Unknown', color: 'var(--muted-foreground)' },
};

const METRIC_LABELS: Record<string, string> = {
  connections: 'Connections',
  ops_per_sec: 'Ops/sec',
  memory_used: 'Memory',
  input_kbps: 'Input KB/s',
  output_kbps: 'Output KB/s',
  slowlog_last_id: 'Slow Queries',
  acl_denied: 'ACL Denied',
  evicted_keys: 'Evictions',
  blocked_clients: 'Blocked',
  keyspace_misses: 'Cache Misses',
  fragmentation_ratio: 'Fragmentation',
  replication_role: 'Replication Role',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatValue(value: number, metric: string): string {
  if (metric === 'memory_used') {
    if (value > 1e9) return `${(value / 1e9).toFixed(2)} GB`;
    if (value > 1e6) return `${(value / 1e6).toFixed(1)} MB`;
    return `${(value / 1e3).toFixed(0)} KB`;
  }
  if (metric === 'fragmentation_ratio') return value.toFixed(2);
  if (value > 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value > 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString();
}

export function AnomalyDashboard() {
  const { currentConnection } = useConnection();
  const [searchParams] = useSearchParams();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Time filter — initialise from URL ?start=&end= (epoch ms)
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    const s = searchParams.get('start');
    const e = searchParams.get('end');
    if (s && e) {
      const from = new Date(Number(s));
      const to = new Date(Number(e));
      if (!isNaN(from.getTime()) && !isNaN(to.getTime())) return { from, to };
    }
    return undefined;
  });

  const startTime = dateRange?.from ? dateRange.from.getTime() : undefined;
  const endTime = dateRange?.to ? dateRange.to.getTime() : undefined;

  const { data: summary } = usePolling<AnomalySummary>({
    fetcher: () => metricsApi.getAnomalySummary({ startTime, endTime }),
    interval: 5000,
    refetchKey: currentConnection?.id,
  });

  const { data: events } = usePolling<AnomalyEvent[]>({
    fetcher: () => metricsApi.getAnomalyEvents({ startTime, endTime }),
    interval: 5000,
    refetchKey: currentConnection?.id,
  });

  const { data: groups } = usePolling<CorrelatedGroup[]>({
    fetcher: () => metricsApi.getAnomalyGroups({ startTime, endTime }),
    interval: 5000,
    refetchKey: currentConnection?.id,
  });

  const { data: buffers } = usePolling<any[]>({
    fetcher: () => metricsApi.getAnomalyBuffers(),
    interval: 10000,
    refetchKey: currentConnection?.id,
  });

  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Timeline data for chart
  const effectiveRangeMs = startTime != null
    ? (endTime ?? Date.now()) - startTime
    : 24 * 3_600_000; // fallback: 24 h when no range selected

  const timelineData = useMemo(() => {
    if (!events?.length || effectiveRangeMs <= 0) return [];

    const bucketSize = effectiveRangeMs / 60; // 60 buckets
    const buckets: Record<number, { critical: number; warning: number; info: number }> = {};

    for (const event of events) {
      const bucket = Math.floor(event.timestamp / bucketSize) * bucketSize;
      if (!buckets[bucket]) buckets[bucket] = { critical: 0, warning: 0, info: 0 };
      buckets[bucket][event.severity]++;
    }

    return Object.entries(buckets)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([ts, counts]) => ({ time: formatTime(parseInt(ts)), ...counts }));
  }, [events, effectiveRangeMs]);

  // Metrics breakdown for bar chart
  const metricsData = useMemo(() => {
    if (!summary?.byMetric) return [];
    return Object.entries(summary.byMetric)
      .map(([metric, count]) => ({ metric: METRIC_LABELS[metric] || metric, count }))
      .sort((a, b) => (b.count as number) - (a.count as number))
      .slice(0, 8);
  }, [summary]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Anomaly Detection</h1>
          <p className="text-muted-foreground">Real-time monitoring across all metrics</p>
        </div>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Anomalies</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{summary?.totalEvents ?? 0}</div>
            <p className="text-xs text-muted-foreground mt-1">in selected time range</p>
          </CardContent>
        </Card>

        <Card className={summary?.bySeverity?.critical ? 'border-destructive/50' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-destructive" />
              Critical
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-destructive">{summary?.bySeverity?.critical ?? 0}</div>
            <p className="text-xs text-muted-foreground mt-1">require attention</p>
          </CardContent>
        </Card>

        <Card className={summary?.bySeverity?.warning ? 'border-yellow-500/50' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
              Warnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-yellow-500">{summary?.bySeverity?.warning ?? 0}</div>
            <p className="text-xs text-muted-foreground mt-1">above normal</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Correlated Events
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{summary?.totalGroups ?? 0}</div>
            <p className="text-xs text-muted-foreground mt-1">pattern groups</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Timeline Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Anomaly Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            {timelineData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={timelineData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="critical" stackId="1" stroke="var(--destructive)" fill="var(--destructive)" fillOpacity={0.6} />
                  <Area type="monotone" dataKey="warning" stackId="1" stroke="var(--chart-warning)" fill="var(--chart-warning)" fillOpacity={0.6} />
                  <Area type="monotone" dataKey="info" stackId="1" stroke="var(--chart-info)" fill="var(--chart-info)" fillOpacity={0.6} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                No anomalies detected in time range
              </div>
            )}
          </CardContent>
        </Card>

        {/* Metrics Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">By Metric Type</CardTitle>
          </CardHeader>
          <CardContent>
            {metricsData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={metricsData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="metric" tick={{ fontSize: 10 }} width={80} />
                  <Tooltip />
                  <Bar dataKey="count" fill="var(--primary)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                No metric data available
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Correlated Anomaly Groups */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Correlated Events & Diagnoses</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {groups?.length ? (
            groups.map(group => {
              const isExpanded = expandedGroups.has(group.correlationId);
              const config = SEVERITY_CONFIG[group.severity];
              const patternConfig = PATTERN_CONFIG[group.pattern] || PATTERN_CONFIG.unknown;
              const PatternIcon = patternConfig.icon;

              return (
                <div
                  key={group.correlationId}
                  className={`border rounded-lg overflow-hidden ${config.border}`}
                >
                  {/* Header */}
                  <div
                    className={`p-4 cursor-pointer hover:bg-muted/50 transition-colors ${config.bg}`}
                    onClick={() => toggleGroup(group.correlationId)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${config.bg}`}>
                          <PatternIcon className={`w-5 h-5 ${config.color}`} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold">{patternConfig.label}</h3>
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${config.bg} ${config.color}`}>
                              {group.severity.toUpperCase()}
                            </span>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {formatTime(group.timestamp)} · {group.anomalies.length} related anomalies
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="border-t p-4 space-y-4">
                      {/* Diagnosis */}
                      <div>
                        <h4 className="text-sm font-semibold mb-2">Diagnosis</h4>
                        <p className="text-sm text-muted-foreground">{group.diagnosis}</p>
                      </div>

                      {/* Related Anomalies */}
                      <div>
                        <h4 className="text-sm font-semibold mb-2">Affected Metrics</h4>
                        <div className="grid gap-2">
                          {group.anomalies.map(anomaly => (
                            <div
                              key={anomaly.id}
                              className="flex items-center justify-between p-2 bg-muted/30 rounded text-sm"
                            >
                              <div className="flex items-center gap-2">
                                {anomaly.anomalyType === 'spike' ? (
                                  <TrendingUp className="w-4 h-4 text-destructive" />
                                ) : (
                                  <TrendingDown className="w-4 h-4 text-primary" />
                                )}
                                <span className="font-medium">{METRIC_LABELS[anomaly.metricType] || anomaly.metricType}</span>
                              </div>
                              <div className="flex items-center gap-4 text-muted-foreground">
                                <span>
                                  {formatValue(anomaly.value, anomaly.metricType)}
                                  <span className="text-xs ml-1">
                                    ({anomaly.zScore > 0 ? '+' : ''}{anomaly.zScore.toFixed(1)}σ)
                                  </span>
                                </span>
                                <span className="text-xs">
                                  baseline: {formatValue(anomaly.baseline, anomaly.metricType)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Recommendations */}
                      <div>
                        <h4 className="text-sm font-semibold mb-2">Recommendations</h4>
                        <ul className="space-y-1">
                          {group.recommendations.map((rec, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm">
                              <span className="text-primary mt-0.5">•</span>
                              <span className="text-muted-foreground">{rec}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Activity className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No correlated anomalies detected</p>
              <p className="text-sm">Events will appear here when patterns are identified</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Individual Anomalies */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Anomaly Events</CardTitle>
        </CardHeader>
        <CardContent>
          {events?.length ? (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {events.slice(0, 50).map(event => {
                const config = SEVERITY_CONFIG[event.severity];
                const SeverityIcon = config.icon;

                return (
                  <div
                    key={event.id}
                    className={`flex items-center justify-between p-3 rounded-lg border ${config.border} ${config.bg}`}
                  >
                    <div className="flex items-center gap-3">
                      <SeverityIcon className={`w-4 h-4 ${config.color}`} />
                      <div>
                        <p className="text-sm font-medium">{event.message}</p>
                        <p className="text-xs text-muted-foreground">{formatTime(event.timestamp)}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-mono">{formatValue(event.value, event.metricType)}</p>
                      <p className="text-xs text-muted-foreground">
                        {event.zScore > 0 ? '+' : ''}{event.zScore.toFixed(1)}σ from baseline
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Info className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No anomalies detected</p>
              <p className="text-sm">System is operating within normal parameters</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Buffer Stats (Debug) */}
      {buffers && buffers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Metric Baselines (Debug)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 text-sm">
              {buffers.map((buffer: any) => (
                <div key={buffer.metricType} className="p-2 bg-muted/30 rounded">
                  <p className="font-medium truncate">{METRIC_LABELS[buffer.metricType] || buffer.metricType}</p>
                  <p className="text-muted-foreground">
                    μ: {formatValue(buffer.mean, buffer.metricType)}
                  </p>
                  <p className="text-muted-foreground">
                    σ: {formatValue(buffer.stdDev, buffer.metricType)}
                  </p>
                  <p className={buffer.isReady ? 'text-green-500' : 'text-yellow-500'}>
                    {buffer.isReady ? '● Ready' : '○ Warming up'}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
