import { useState, useMemo, useCallback } from 'react';
import { metricsApi } from '../api/metrics';
import { usePolling } from '../hooks/usePolling';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Badge } from '../components/ui/badge';
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type {
  CommandDistributionResponse,
  IdleConnectionsResponse,
  BufferAnomaliesResponse,
  ActivityTimelineResponse,
  SpikeDetectionResponse,
} from '../types/metrics';

type TimeRange = '1h' | '6h' | '24h';

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '1h': 3600000,
  '6h': 6 * 3600000,
  '24h': 24 * 3600000,
};

function formatShortTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

const CHART_COLORS = ['hsl(var(--primary))', '#8884d8', '#82ca9d', '#ffc658', '#ff8042', '#a4de6c', '#d0ed57', '#ffa07a'];

export function ClientAnalyticsDeepDive() {
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [activeTab, setActiveTab] = useState<string>('commands');

  const timeRangeParams = useMemo(() => {
    const now = Date.now();
    return { start: now - TIME_RANGE_MS[timeRange], end: now };
  }, [timeRange]);

  // Fetchers as stable callbacks
  const fetchCommandDist = useCallback(
    () => metricsApi.getCommandDistribution({ startTime: timeRangeParams.start, endTime: timeRangeParams.end }),
    [timeRangeParams]
  );
  const fetchIdleConns = useCallback(
    () => metricsApi.getIdleConnections({ idleThresholdSeconds: 300, minOccurrences: 5 }),
    []
  );
  const fetchBufferAnomalies = useCallback(
    () => metricsApi.getBufferAnomalies({ startTime: timeRangeParams.start, endTime: timeRangeParams.end }),
    [timeRangeParams]
  );
  const fetchActivityTimeline = useCallback(
    () => metricsApi.getActivityTimeline({ startTime: timeRangeParams.start, endTime: timeRangeParams.end, bucketSizeMinutes: 5 }),
    [timeRangeParams]
  );
  const fetchSpikes = useCallback(
    () => metricsApi.detectSpikes({ startTime: timeRangeParams.start, endTime: timeRangeParams.end }),
    [timeRangeParams]
  );

  // Always fetch timeline and spikes (used in summary and main chart)
  const { data: activityTimeline, loading: timelineLoading } = usePolling<ActivityTimelineResponse>({
    fetcher: fetchActivityTimeline,
    interval: 30000,
  });

  const { data: spikes } = usePolling<SpikeDetectionResponse>({
    fetcher: fetchSpikes,
    interval: 60000,
  });

  // Conditionally fetch based on active tab
  const { data: commandDist, loading: cmdLoading } = usePolling<CommandDistributionResponse>({
    fetcher: fetchCommandDist,
    interval: 30000,
    enabled: activeTab === 'commands',
  });

  const { data: idleConns, loading: idleLoading } = usePolling<IdleConnectionsResponse>({
    fetcher: fetchIdleConns,
    interval: 30000,
    enabled: activeTab === 'idle',
  });

  const { data: bufferAnomalies, loading: bufferLoading } = usePolling<BufferAnomaliesResponse>({
    fetcher: fetchBufferAnomalies,
    interval: 30000,
    enabled: activeTab === 'anomalies',
  });

  // Summary cards data
  const summaryData = useMemo(() => {
    const activeClients = commandDist?.distribution.length || 0;
    const idleCount = idleConns?.connections.length || 0;
    const bufferWarnings = bufferAnomalies?.anomalies.filter(a => a.severity === 'warning').length || 0;
    const bufferCritical = bufferAnomalies?.anomalies.filter(a => a.severity === 'critical').length || 0;
    const todaySpikes = spikes?.spikes.length || 0;

    return { activeClients, idleCount, bufferWarnings, bufferCritical, todaySpikes };
  }, [commandDist, idleConns, bufferAnomalies, spikes]);

  // Prepare command distribution pie chart data
  const commandPieData = useMemo(() => {
    if (!commandDist?.distribution) return [];

    const commandTotals: Record<string, number> = {};
    commandDist.distribution.forEach(d => {
      Object.entries(d.commands).forEach(([cmd, count]) => {
        commandTotals[cmd] = (commandTotals[cmd] || 0) + count;
      });
    });

    return Object.entries(commandTotals)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8); // Top 8 commands
  }, [commandDist]);

  // Activity timeline chart data with spikes
  const timelineChartData = useMemo(() => {
    if (!activityTimeline?.buckets) return [];
    return activityTimeline.buckets.map(bucket => ({
      time: formatShortTime(bucket.timestamp),
      timestamp: bucket.timestamp,
      connections: bucket.totalConnections,
      uniqueClients: bucket.uniqueClients,
      avgIdle: Math.round(bucket.avgIdleSeconds),
    }));
  }, [activityTimeline]);

  // Spike markers for timeline
  const spikeMarkers = useMemo(() => {
    if (!spikes?.spikes) return [];
    return spikes.spikes
      .filter(s => s.metric === 'connections')
      .map(s => s.timestamp);
  }, [spikes]);


  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Client Analytics Deep Dive</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Advanced analytics and anomaly detection for client connections
          </p>
        </div>
        <div className="flex gap-2">
          {(['1h', '6h', '24h'] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-3 py-1 rounded text-sm ${
                timeRange === range
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              {range.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Active Clients</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summaryData.activeClients}</div>
            <div className="text-xs text-muted-foreground mt-1">With activity</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Idle Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summaryData.idleCount}</div>
            <div className="text-xs text-muted-foreground mt-1">&gt;5 min idle</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Buffer Warnings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{summaryData.bufferWarnings}</div>
            <div className="text-xs text-muted-foreground mt-1">Elevated buffers</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Critical Buffers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{summaryData.bufferCritical}</div>
            <div className="text-xs text-muted-foreground mt-1">Needs attention</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Spikes Detected</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summaryData.todaySpikes}</div>
            <div className="text-xs text-muted-foreground mt-1">In time range</div>
          </CardContent>
        </Card>
      </div>

      {/* Activity Timeline Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Activity Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {timelineLoading ? (
            <div className="h-64 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : timelineChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={timelineChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" />
                <YAxis />
                <Tooltip />
                {spikeMarkers.map(timestamp => {
                  const dataPoint = timelineChartData.find(d => d.timestamp === timestamp);
                  return dataPoint ? (
                    <ReferenceLine
                      key={timestamp}
                      x={dataPoint.time}
                      stroke="red"
                      strokeDasharray="3 3"
                      label={{ value: 'Spike', position: 'top', fill: 'red', fontSize: 10 }}
                    />
                  ) : null;
                })}
                <Area
                  type="monotone"
                  dataKey="connections"
                  stroke="hsl(var(--primary))"
                  fill="hsl(var(--primary))"
                  fillOpacity={0.3}
                  name="Total Connections"
                />
                <Area
                  type="monotone"
                  dataKey="uniqueClients"
                  stroke="#82ca9d"
                  fill="#82ca9d"
                  fillOpacity={0.2}
                  name="Unique Clients"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-64 flex items-center justify-center text-muted-foreground">
              No timeline data available
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabs for detailed views */}
      <Tabs defaultValue="commands" className="w-full" onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="commands">Command Distribution</TabsTrigger>
          <TabsTrigger value="idle">Idle Connections</TabsTrigger>
          <TabsTrigger value="anomalies">Buffer Anomalies</TabsTrigger>
        </TabsList>

        {/* Command Distribution Tab */}
        <TabsContent value="commands" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Pie Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Top Commands by Volume</CardTitle>
              </CardHeader>
              <CardContent>
                {cmdLoading ? (
                  <div className="h-64 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                  </div>
                ) : commandPieData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={commandPieData}
                        cx="50%"
                        cy="50%"
                        labelLine={false}
                        label={({ name, percent }) => `${name} (${((percent || 0) * 100).toFixed(0)}%)`}
                        outerRadius={100}
                        fill="hsl(var(--primary))"
                        dataKey="value"
                      >
                        {commandPieData.map((_, index) => (
                          <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-64 flex items-center justify-center text-muted-foreground">
                    No command data available
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Client Breakdown Table */}
            <Card>
              <CardHeader>
                <CardTitle>Client Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-80 overflow-y-auto">
                  {cmdLoading ? (
                    <div className="h-64 flex items-center justify-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                    </div>
                  ) : commandDist?.distribution && commandDist.distribution.length > 0 ? (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background">
                        <tr className="border-b">
                          <th className="text-left p-2">Client</th>
                          <th className="text-left p-2">Top Command</th>
                          <th className="text-right p-2">Total</th>
                          <th className="text-right p-2">Activity %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {commandDist.distribution.slice(0, 20).map((client) => (
                          <tr key={client.identifier} className="border-b hover:bg-muted">
                            <td className="p-2 font-mono text-xs">{client.identifier}</td>
                            <td className="p-2">
                              <Badge variant="outline">{client.topCommand || 'N/A'}</Badge>
                            </td>
                            <td className="p-2 text-right">{client.totalCommands}</td>
                            <td className="p-2 text-right">{client.activityPercentage.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="h-64 flex items-center justify-center text-muted-foreground">
                      No client data available
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Idle Connections Tab */}
        <TabsContent value="idle">
          <Card>
            <CardHeader>
              <CardTitle>Idle Connections Analysis</CardTitle>
              {idleConns?.summary && (
                <p className="text-sm text-muted-foreground">
                  {idleConns.summary.potentialWastedResources}
                </p>
              )}
            </CardHeader>
            <CardContent>
              {idleLoading ? (
                <div className="h-64 flex items-center justify-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                </div>
              ) : idleConns?.connections && idleConns.connections.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-2">Client</th>
                        <th className="text-left p-2">Address</th>
                        <th className="text-left p-2">User</th>
                        <th className="text-right p-2">Avg Idle</th>
                        <th className="text-right p-2">Max Idle</th>
                        <th className="text-right p-2">Occurrences</th>
                        <th className="text-left p-2">Recommendation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {idleConns.connections.map((conn, idx) => (
                        <tr key={idx} className="border-b hover:bg-muted">
                          <td className="p-2 font-mono text-xs">{conn.identifier}</td>
                          <td className="p-2 font-mono text-xs">{conn.addr}</td>
                          <td className="p-2 font-mono text-xs">{conn.user}</td>
                          <td className="p-2 text-right">{Math.round(conn.avgIdleSeconds)}s</td>
                          <td className="p-2 text-right">{Math.round(conn.maxIdleSeconds)}s</td>
                          <td className="p-2 text-right">{conn.occurrences}</td>
                          <td className="p-2">
                            <span className="text-xs text-muted-foreground">{conn.recommendation}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  No idle connections detected
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Buffer Anomalies Tab */}
        <TabsContent value="anomalies">
          <div className="space-y-4">
            {/* Stats Summary */}
            {bufferAnomalies?.stats && (
              <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xs">Avg Input Buffer</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm font-bold">{formatBytes(bufferAnomalies.stats.avgQbuf)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xs">Max Input Buffer</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm font-bold">{formatBytes(bufferAnomalies.stats.maxQbuf)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xs">P95 Input Buffer</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm font-bold">{formatBytes(bufferAnomalies.stats.p95Qbuf)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xs">Avg Output Buffer</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm font-bold">{formatBytes(bufferAnomalies.stats.avgOmem)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xs">Max Output Buffer</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm font-bold">{formatBytes(bufferAnomalies.stats.maxOmem)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xs">P95 Output Buffer</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm font-bold">{formatBytes(bufferAnomalies.stats.p95Omem)}</div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Anomalies Table */}
            <Card>
              <CardHeader>
                <CardTitle>Buffer Anomalies Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                {bufferLoading ? (
                  <div className="h-64 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                  </div>
                ) : bufferAnomalies?.anomalies && bufferAnomalies.anomalies.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left p-2">Time</th>
                          <th className="text-left p-2">Client</th>
                          <th className="text-left p-2">Command</th>
                          <th className="text-right p-2">Input Buffer</th>
                          <th className="text-right p-2">Output Buffer</th>
                          <th className="text-left p-2">Severity</th>
                          <th className="text-left p-2">Recommendation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bufferAnomalies.anomalies.slice(0, 50).map((anomaly, idx) => (
                          <tr key={idx} className="border-b hover:bg-muted">
                            <td className="p-2 text-xs">{formatShortTime(anomaly.timestamp)}</td>
                            <td className="p-2 font-mono text-xs">{anomaly.identifier}</td>
                            <td className="p-2">
                              <Badge variant="outline">{anomaly.lastCommand}</Badge>
                            </td>
                            <td className="p-2 text-right">{formatBytes(anomaly.qbuf)}</td>
                            <td className="p-2 text-right">{formatBytes(anomaly.omem)}</td>
                            <td className="p-2">
                              <Badge variant={anomaly.severity === 'critical' ? 'destructive' : 'secondary'}>
                                {anomaly.severity}
                              </Badge>
                            </td>
                            <td className="p-2 text-xs text-muted-foreground">{anomaly.recommendation}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    No buffer anomalies detected
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
