import { useState, useEffect } from 'react';
import { metricsApi } from '../api/metrics';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { DoctorCard } from '../components/DoctorCard';
import type { LatencyHistoryEntry } from '../types/metrics';

const EVENTS_POLL_INTERVAL_MS = 10_000;
const HISTOGRAM_POLL_INTERVAL_MS = 30_000;
const TOP_COMMANDS_LIMIT = 10;
const CHART_HEIGHT = { sm: 300, md: 400 };

const COLORS = {
  p50: '#82ca9d',
  p95: '#8884d8',
  p99: '#ffc658',
};

const GRADIENT_STOPS = { startOffset: '5%', endOffset: '95%', startOpacity: 0.3, endOpacity: 0.1 };

const CHART_MARGIN = { left: 20, right: 20, top: 20, bottom: 20 };

const Y_AXIS_LABEL = { angle: -90, position: 'insideLeft' as const, dx: -12, dy: 70 };

const COMMAND_X_AXIS = { angle: -45, textAnchor: 'end' as const, height: 100 };

export function Latency() {
  const { currentConnection } = useConnection();
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<LatencyHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [doctorReport, setDoctorReport] = useState<string>();
  const [doctorLoading, setDoctorLoading] = useState(true);

  const { data: latencyEvents } = usePolling({
    fetcher: metricsApi.getLatencyLatest,
    interval: EVENTS_POLL_INTERVAL_MS,
    refetchKey: currentConnection?.id,
  });

  const { data: histogramData } = usePolling({
    fetcher: () => metricsApi.getLatencyHistogram(),
    interval: HISTOGRAM_POLL_INTERVAL_MS,
    refetchKey: currentConnection?.id,
  });

  useEffect(() => {
    if (selectedEvent) {
      setHistoryLoading(true);
      setHistoryError(null);
      metricsApi.getLatencyHistory(selectedEvent)
        .then(setHistoryData)
        .catch((err) => setHistoryError(err.message || 'Failed to fetch history'))
        .finally(() => setHistoryLoading(false));
    }
  }, [selectedEvent]);

  useEffect(() => {
    setDoctorLoading(true);
    metricsApi.getLatencyDoctor()
      .then(data => setDoctorReport(data.report))
      .catch(console.error)
      .finally(() => setDoctorLoading(false));
  }, [currentConnection?.id]);

  const formatLatency = (latency: number) => {
    if (latency < 1000) return `${latency}µs`;
    if (latency < 1000000) return `${(latency / 1000).toFixed(2)}ms`;
    return `${(latency / 1000000).toFixed(2)}s`;
  };

  const chartData = historyData.map(entry => ({
    time: new Date(entry.timestamp * 1000).toLocaleTimeString(),
    latency: entry.latency / 1000,
  }));

  const calculatePercentiles = (histogram: { [bucket: string]: number }) => {
    const buckets = Object.entries(histogram)
      .map(([bucket, count]) => ({ bucket: parseInt(bucket), count }))
      .sort((a, b) => a.bucket - b.bucket);

    if (buckets.length === 0) return { p50: 0, p95: 0, p99: 0 };

    const total = buckets.reduce((sum, b) => sum + b.count, 0);

    const findPercentile = (percent: number) => {
      const target = total * (percent / 100);
      let cumulative = 0;
      for (const { bucket, count } of buckets) {
        cumulative += count;
        if (cumulative >= target) return bucket;
      }
      return buckets[buckets.length - 1].bucket;
    };

    return {
      p50: findPercentile(50),
      p95: findPercentile(95),
      p99: findPercentile(99),
    };
  };

  const topCommands = histogramData
    ? Object.entries(histogramData)
      .filter(([cmd]) => !cmd.startsWith('latency|') && !cmd.startsWith('config|'))
      .sort(([, a], [, b]) => b.calls - a.calls)
      .slice(0, TOP_COMMANDS_LIMIT)
      .map(([command, data]) => {
        const percentiles = calculatePercentiles(data.histogram);
        return {
          command,
          calls: data.calls,
          p50: percentiles.p50,
          p95: percentiles.p95,
          p99: percentiles.p99,
        };
      })
    : [];

  const selectedCommandData = selectedCommand && histogramData?.[selectedCommand];
  const latencyDistribution = selectedCommandData
    ? Object.entries(selectedCommandData.histogram)
      .map(([bucket, count]) => ({
        latency: parseInt(bucket),
        count,
      }))
      .sort((a, b) => a.latency - b.latency)
    : [];

  const renderGradient = (id: string, color: string) => (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset={GRADIENT_STOPS.startOffset} stopColor={color} stopOpacity={GRADIENT_STOPS.startOpacity} />
      <stop offset={GRADIENT_STOPS.endOffset} stopColor={color} stopOpacity={GRADIENT_STOPS.endOpacity} />
    </linearGradient>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Latency Monitoring</h1>

      <DoctorCard
        title="Latency Doctor"
        report={doctorReport}
        isLoading={doctorLoading}
      />

      <Card>
        <CardHeader>
          <CardTitle>Latest Latency Events (System-level)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latencyEvents && latencyEvents.length > 0 ? (
                latencyEvents.map((event) => (
                  <TableRow
                    key={event.eventName}
                    onClick={() => setSelectedEvent(event.eventName)}
                    className={`cursor-pointer ${selectedEvent === event.eventName ? 'bg-muted' : ''}`}
                  >
                    <TableCell className="font-medium">{event.eventName}</TableCell>
                    <TableCell className="font-mono">{formatLatency(event.latency)}</TableCell>
                    <TableCell>{new Date(event.timestamp * 1000).toLocaleString()}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    No system-level events recorded (fork, AOF, etc.)
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedEvent && (
        <Card>
          <CardHeader>
            <CardTitle>Latency History: {selectedEvent}</CardTitle>
          </CardHeader>
          <CardContent>
            {historyLoading ? (
              <div className="text-center text-muted-foreground py-8">Loading history...</div>
            ) : historyError ? (
              <div className="text-center text-destructive py-8">{historyError}</div>
            ) : historyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={CHART_HEIGHT.sm}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" />
                  <YAxis label={{ value: 'Latency (ms)', angle: -90, position: 'insideLeft' }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="latency" stroke={COLORS.p95} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center text-muted-foreground py-8">
                No history data available for this event
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Command Latency Percentiles - Top 10 Commands by Call Volume</CardTitle>
        </CardHeader>
        <CardContent>
          {topCommands.length > 0 ? (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT.md}>
              <AreaChart data={topCommands} margin={CHART_MARGIN}>
                <defs>
                  {renderGradient('colorP50', COLORS.p50)}
                  {renderGradient('colorP95', COLORS.p95)}
                  {renderGradient('colorP99', COLORS.p99)}
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="command" {...COMMAND_X_AXIS} />
                <YAxis
                  label={{ value: 'Execution Latency', ...Y_AXIS_LABEL }}
                  tickFormatter={(value) => formatLatency(value)}
                />
                <Tooltip
                  formatter={(value) => value != null ? formatLatency(value as number) : ''}
                  labelFormatter={(label) => `Command: ${label}`}
                />
                <Legend />
                <Area type="monotone" dataKey="p99" stroke={COLORS.p99} strokeWidth={2} fill="url(#colorP99)" name="99th Percentile" />
                <Area type="monotone" dataKey="p95" stroke={COLORS.p95} strokeWidth={2} fill="url(#colorP95)" name="95th Percentile" />
                <Area type="monotone" dataKey="p50" stroke={COLORS.p50} strokeWidth={2} fill="url(#colorP50)" name="50th Percentile (Median)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center text-muted-foreground py-8">No command data available</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Percentile Comparison by Command</CardTitle>
        </CardHeader>
        <CardContent>
          {topCommands.length > 0 ? (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT.md}>
              <BarChart data={topCommands} layout="horizontal" margin={CHART_MARGIN}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="command" {...COMMAND_X_AXIS} />
                <YAxis
                  label={{ value: 'Execution Latency', ...Y_AXIS_LABEL }}
                  tickFormatter={(value) => formatLatency(value)}
                />
                <Tooltip
                  formatter={(value) => value != null ? formatLatency(value as number) : ''}
                  labelFormatter={(label) => `Command: ${label}`}
                />
                <Legend />
                <Bar dataKey="p50" fill={COLORS.p50} name="50th Percentile (Median)" />
                <Bar dataKey="p95" fill={COLORS.p95} name="95th Percentile" />
                <Bar dataKey="p99" fill={COLORS.p99} name="99th Percentile" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center text-muted-foreground py-8">No command data available</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data Table - Exact Values</CardTitle>
        </CardHeader>
        <CardContent>
          {topCommands.length > 0 ? (
            <>
              <div className="text-sm text-muted-foreground mb-4">
                Click a command to see detailed latency distribution
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Command</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">P50</TableHead>
                    <TableHead className="text-right">P95</TableHead>
                    <TableHead className="text-right">P99</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topCommands.map((cmd) => (
                    <TableRow
                      key={cmd.command}
                      onClick={() => setSelectedCommand(cmd.command)}
                      className={`cursor-pointer ${selectedCommand === cmd.command ? 'bg-muted' : ''}`}
                    >
                      <TableCell className="font-medium">{cmd.command}</TableCell>
                      <TableCell className="text-right">{cmd.calls.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono">{formatLatency(cmd.p50)}</TableCell>
                      <TableCell className="text-right font-mono">{formatLatency(cmd.p95)}</TableCell>
                      <TableCell className="text-right font-mono">{formatLatency(cmd.p99)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : (
            <div className="text-center text-muted-foreground py-8">No command data available</div>
          )}
        </CardContent>
      </Card>

      {selectedCommand && selectedCommandData && (
        <Card>
          <CardHeader>
            <CardTitle>Latency Distribution: {selectedCommand}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={CHART_HEIGHT.sm}>
              <BarChart data={latencyDistribution}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="latency"
                  label={{ value: 'Latency (µs)', position: 'insideBottom', offset: -5 }}
                  tickFormatter={(value) => formatLatency(value)}
                />
                <YAxis label={{ value: 'Cumulative Count', angle: -90, position: 'insideLeft' }} />
                <Tooltip
                  formatter={(value, name) => {
                    if (value == null) return ['', ''];
                    if (name === 'count') return [(value as number).toLocaleString(), 'Operations'];
                    return [value, name];
                  }}
                  labelFormatter={(label) => `≤ ${formatLatency(label as number)}`}
                />
                <Bar dataKey="count" fill={COLORS.p95} />
              </BarChart>
            </ResponsiveContainer>
            <div className="text-sm text-muted-foreground mt-4">
              Total calls: {selectedCommandData.calls.toLocaleString()}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
