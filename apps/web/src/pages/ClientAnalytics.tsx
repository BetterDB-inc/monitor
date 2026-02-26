import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { metricsApi } from '../api/metrics';
import { settingsApi } from '../api/settings';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { useCapabilities } from '../hooks/useCapabilities';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { UnavailableOverlay } from '../components/UnavailableOverlay';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

type TimeRange = '1h' | '6h' | '24h' | '7d' | 'custom';

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatShortTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function getTimeRangeMs(range: TimeRange): { start: number; end: number; bucket: number } {
  const now = Date.now();
  switch (range) {
    case '1h':
      return { start: now - 3600000, end: now, bucket: 60000 };
    case '6h':
      return { start: now - 6 * 3600000, end: now, bucket: 300000 };
    case '24h':
      return { start: now - 24 * 3600000, end: now, bucket: 900000 };
    case '7d':
      return { start: now - 7 * 24 * 3600000, end: now, bucket: 3600000 };
    default:
      return { start: now - 3600000, end: now, bucket: 60000 };
  }
}

export function ClientAnalytics() {
  const { currentConnection } = useConnection();
  const { hasClientList } = useCapabilities();
  const [searchParams] = useSearchParams();
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [selectedClient, setSelectedClient] = useState<{ name?: string; user?: string; addr?: string } | null>(null);

  useEffect(() => {
    const name = searchParams.get('name');
    const user = searchParams.get('user');
    const addr = searchParams.get('addr');
    if (name || user || addr) {
      setSelectedClient({
        ...(name && { name }),
        ...(user && { user }),
        ...(addr && { addr }),
      });
    }
  }, [searchParams]);

  const { start, end, bucket } = getTimeRangeMs(timeRange);

  // Fetch settings to get the polling interval
  const { data: settingsResponse } = usePolling({
    fetcher: () => settingsApi.getSettings(),
    interval: 30000, // Refresh settings every 30 seconds
    refetchKey: currentConnection?.id,
  });

  const pollInterval = settingsResponse?.settings.clientAnalyticsPollIntervalMs || 10000;

  const { data: stats, loading: statsLoading } = usePolling({
    fetcher: () => metricsApi.getClientAnalyticsStats(start, end),
    interval: pollInterval,
    refetchKey: currentConnection?.id,
  });

  const { data: timeSeries } = usePolling({
    fetcher: () => metricsApi.getClientTimeSeries(start, end, bucket),
    interval: pollInterval,
    refetchKey: currentConnection?.id,
  });

  const { data: connectionHistory, loading: historyLoading } = usePolling({
    fetcher: selectedClient
      ? () => metricsApi.getClientConnectionHistory(selectedClient, start, end)
      : () => Promise.resolve([]),
    interval: pollInterval,
    enabled: !!selectedClient,
    refetchKey: currentConnection?.id,
  });

  const chartData = useMemo(() => {
    if (!timeSeries) return [];
    return timeSeries.map(point => ({
      time: formatShortTime(point.timestamp),
      connections: point.totalConnections,
    }));
  }, [timeSeries]);

  const topClients = useMemo(() => {
    if (!stats?.connectionsByName) return [];
    return Object.entries(stats.connectionsByName)
      .map(([name, info]) => ({ name, ...info }))
      .sort((a, b) => b.peak - a.peak)
      .slice(0, 10);
  }, [stats?.connectionsByName]);

  const userClientBreakdown = useMemo(() => {
    if (!stats?.connectionsByUserAndName) return [];
    return Object.values(stats.connectionsByUserAndName)
      .sort((a, b) => b.peak - a.peak)
      .slice(0, 20);
  }, [stats?.connectionsByUserAndName]);

  const content = (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Client Analytics</h1>
        <div className="flex gap-2">
          {(['1h', '6h', '24h', '7d'] as TimeRange[]).map((range) => (
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

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Current Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.currentConnections ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Peak Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.peakConnections ?? 0}</div>
            {stats?.peakTimestamp && (
              <div className="text-xs text-muted-foreground mt-1">
                {formatShortTime(stats.peakTimestamp)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Unique Clients</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.uniqueClientNames ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Unique Users</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.uniqueUsers ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Unique IPs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.uniqueIps ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Time Range</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.timeRange ? (
              <div className="text-xs">
                <div className="font-mono">{formatShortTime(stats.timeRange.earliest)}</div>
                <div className="text-muted-foreground">to</div>
                <div className="font-mono">{formatShortTime(stats.timeRange.latest)}</div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No data</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Time Series Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Connection Time Series</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" />
                <YAxis />
                <Tooltip />
                <Area
                  type="monotone"
                  dataKey="connections"
                  stroke="hsl(var(--primary))"
                  fill="hsl(var(--primary))"
                  fillOpacity={0.3}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No time series data available. Data will populate as client snapshots are captured.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top Clients Table */}
      <Card>
        <CardHeader>
          <CardTitle>Top Clients by Peak Connections</CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="text-center py-12">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" role="status">
                <span className="!absolute !-m-px !h-px !w-px !overflow-hidden !whitespace-nowrap !border-0 !p-0 ![clip:rect(0,0,0,0)]">Loading...</span>
              </div>
            </div>
          ) : topClients.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Client Name</th>
                    <th className="text-left p-2">Current</th>
                    <th className="text-left p-2">Peak</th>
                    <th className="text-left p-2">Avg Age (s)</th>
                    <th className="text-left p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {topClients.map((client) => (
                    <tr key={client.name} className="border-b hover:bg-muted">
                      <td className="p-2 font-mono">{client.name || '(unnamed)'}</td>
                      <td className="p-2">{client.current}</td>
                      <td className="p-2 font-bold">{client.peak}</td>
                      <td className="p-2">{Math.round(client.avgAge)}</td>
                      <td className="p-2">
                        <button
                          onClick={() => setSelectedClient({ name: client.name })}
                          className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90"
                        >
                          View History
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No client data available yet.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Connections by User + Client Name */}
      <Card>
        <CardHeader>
          <CardTitle>Connections by User + Client Name</CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="text-center py-12">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" role="status">
                <span className="!absolute !-m-px !h-px !w-px !overflow-hidden !whitespace-nowrap !border-0 !p-0 ![clip:rect(0,0,0,0)]">Loading...</span>
              </div>
            </div>
          ) : userClientBreakdown.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">User</th>
                    <th className="text-left p-2">Client Name</th>
                    <th className="text-left p-2">Current</th>
                    <th className="text-left p-2">Peak</th>
                    <th className="text-left p-2">Avg Age (s)</th>
                    <th className="text-left p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {userClientBreakdown.map((combo) => (
                    <tr key={`${combo.user}:${combo.name}`} className="border-b hover:bg-muted">
                      <td className="p-2 font-mono">{combo.user}</td>
                      <td className="p-2 font-mono">{combo.name || '(unnamed)'}</td>
                      <td className="p-2">{combo.current}</td>
                      <td className="p-2 font-bold">{combo.peak}</td>
                      <td className="p-2">{Math.round(combo.avgAge)}</td>
                      <td className="p-2">
                        <button
                          onClick={() => setSelectedClient({ user: combo.user, name: combo.name })}
                          className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90"
                        >
                          View History
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No connection data available yet.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Connection History Detail */}
      {selectedClient && (
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>
                Connection History
                {selectedClient.name && ` - Client: ${selectedClient.name}`}
                {selectedClient.user && ` - User: ${selectedClient.user}`}
                {selectedClient.addr && ` - Address: ${selectedClient.addr}`}
              </CardTitle>
              <button
                onClick={() => setSelectedClient(null)}
                className="text-xs px-2 py-1 bg-muted rounded hover:bg-muted/80"
              >
                Close
              </button>
            </div>
          </CardHeader>
          <CardContent>
            {historyLoading ? (
              <div className="text-center py-12">
                <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" role="status">
                  <span className="!absolute !-m-px !h-px !w-px !overflow-hidden !whitespace-nowrap !border-0 !p-0 ![clip:rect(0,0,0,0)]">Loading...</span>
                </div>
              </div>
            ) : connectionHistory && connectionHistory.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left p-2">Captured At</th>
                      <th className="text-left p-2">Client ID</th>
                      <th className="text-left p-2">Address</th>
                      <th className="text-left p-2">Name</th>
                      <th className="text-left p-2">User</th>
                      <th className="text-left p-2">DB</th>
                      <th className="text-left p-2">Cmd</th>
                      <th className="text-left p-2">Age</th>
                      <th className="text-left p-2">Idle</th>
                      <th className="text-left p-2">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connectionHistory.map((snapshot) => (
                      <tr key={snapshot.id} className="border-b hover:bg-muted">
                        <td className="p-2">{formatTimestamp(snapshot.capturedAt)}</td>
                        <td className="p-2 font-mono text-xs">{snapshot.clientId}</td>
                        <td className="p-2 font-mono text-xs">{snapshot.addr}</td>
                        <td className="p-2 font-mono">{snapshot.name || '-'}</td>
                        <td className="p-2 font-mono">{snapshot.user}</td>
                        <td className="p-2">{snapshot.db}</td>
                        <td className="p-2 font-mono text-xs">{snapshot.cmd || '-'}</td>
                        <td className="p-2">{snapshot.age}s</td>
                        <td className="p-2">{snapshot.idle}s</td>
                        <td className="p-2 font-mono text-xs">{snapshot.flags}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No connection history found for this filter.
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );

  if (!hasClientList) {
    return (
      <UnavailableOverlay featureName="Client Analytics" command="CLIENT LIST">
        {content}
      </UnavailableOverlay>
    );
  }

  return content;
}
