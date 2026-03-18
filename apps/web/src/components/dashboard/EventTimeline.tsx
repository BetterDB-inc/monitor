import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ComposedChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { metricsApi } from '../../api/metrics';
import { useConnection } from '../../hooks/useConnection';
import { useCapabilities } from '../../hooks/useCapabilities';
import type {
  StoredMemorySnapshot,
  SlowLogEntry,
  CommandLogEntry,
  StoredLatencySnapshot,
} from '../../types/metrics';

const BUCKET_COUNT = 60;
const ONE_HOUR_MS = 3_600_000;
const LABEL_WIDTH = 80;

interface AnomalyEvent {
  timestamp: number;
  severity: string;
  metricType: string;
  zScore?: number;
  value?: number;
}

type SelectedEvent =
  | { type: 'slowlog'; items: Array<{ timestamp: number; command: string; duration: number; clientAddress: string }> }
  | { type: 'anomaly'; items: Array<{ timestamp: number; severity: string; metricType: string; zScore: number }> }
  | { type: 'latency'; items: Array<{ timestamp: number; eventName: string; maxLatency: number }> };

interface TimelineBucket {
  idx: number;
  time: number;
  label: string;
  ops: number;
  memMb: number;
  slowCount: number;
  slowMaxDuration: number;
  anomalyCritical: number;
  anomalyWarning: number;
  latencyMax: number;
}


interface BucketEvents {
  slowlogs: (SlowLogEntry | CommandLogEntry)[];
  anomalies: AnomalyEvent[];
  latencies: StoredLatencySnapshot[];
}

interface Props {
  startTime?: number;
  endTime?: number;
}


const tooltipStyle: React.CSSProperties = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
};

// Custom tooltip that reads values from the raw data payload,
// bypassing Recharts' formatter which misresolves values with Cell children.
function LaneTooltip({ active, payload, fields }: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  fields: { key: string; label: string; format?: (v: number) => string }[];
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  if (!data) return null;

  const entries = fields
    .map(f => ({ ...f, value: data[f.key] as number }))
    .filter(f => f.value > 0);
  if (!entries.length) return null;

  return (
    <div style={tooltipStyle}>
      <div style={{ marginBottom: 4, color: 'hsl(var(--muted-foreground))' }}>{data.label}</div>
      {entries.map(e => (
        <div key={e.key}>{e.label}: {e.format ? e.format(e.value) : e.value}</div>
      ))}
    </div>
  );
}

export function EventTimeline({ startTime: propStart, endTime: propEnd }: Props) {
  const { currentConnection } = useConnection();
  const { hasCommandLog } = useCapabilities();
  const navigate = useNavigate();

  const effectiveStart = useMemo(() => propStart ?? (Date.now() - ONE_HOUR_MS), [propStart]);
  const effectiveEnd = useMemo(() => propEnd ?? Date.now(), [propEnd]);

  const [memSnapshots, setMemSnapshots] = useState<StoredMemorySnapshot[]>([]);
  const [slowLogs, setSlowLogs] = useState<(SlowLogEntry | CommandLogEntry)[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyEvent[]>([]);
  const [latencySnapshots, setLatencySnapshots] = useState<StoredLatencySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<SelectedEvent | null>(null);

  // Drag-to-select
  const lanesWrapperRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef({ active: false, startX: 0 });
  const suppressNextClick = useRef(false);
  const [dragSelection, setDragSelection] = useState<{ startMs: number; endMs: number; left: number; width: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelectedEvent(null);
    setDragSelection(null);
    if (overlayRef.current) overlayRef.current.style.display = 'none';

    // Slowlog API expects timestamps in seconds, not milliseconds
    const slowStartSec = Math.floor(effectiveStart / 1000);
    const slowEndSec = Math.floor(effectiveEnd / 1000);
    let slowPromise: Promise<(SlowLogEntry | CommandLogEntry)[]>;
    if (hasCommandLog) {
      slowPromise = metricsApi.getStoredCommandLog({ startTime: slowStartSec, endTime: slowEndSec, limit: 500 });
    } else {
      slowPromise = metricsApi.getStoredSlowLog({ startTime: slowStartSec, endTime: slowEndSec, limit: 500 });
    }

    Promise.all([
      metricsApi.getStoredMemorySnapshots({ startTime: effectiveStart, endTime: effectiveEnd, limit: 500 })
        .catch((): StoredMemorySnapshot[] => []),
      slowPromise
        .catch((): (SlowLogEntry | CommandLogEntry)[] => []),
      metricsApi.getAnomalyEvents({ startTime: effectiveStart, endTime: effectiveEnd })
        .catch((): AnomalyEvent[] => []),
      metricsApi.getStoredLatencySnapshots({ startTime: effectiveStart, endTime: effectiveEnd, limit: 500 })
        .catch((): StoredLatencySnapshot[] => []),
    ]).then(([mem, slow, anom, lat]) => {
      if (cancelled) return;
      setMemSnapshots(mem);
      setSlowLogs(slow);
      setAnomalies(anom as AnomalyEvent[]);
      setLatencySnapshots(lat);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [effectiveStart, effectiveEnd, currentConnection?.id, hasCommandLog]);

  const { buckets, bucketEvents } = useMemo(() => {
    const range = effectiveEnd - effectiveStart;
    const bucketMs = range / BUCKET_COUNT;
    const bkts: TimelineBucket[] = [];
    const evts: BucketEvents[] = [];

    const formatBucketLabel = (ts: number) => {
      const d = new Date(ts);
      if (range > 7 * 86_400_000) {
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
      if (range > 86_400_000) {
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
          d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    for (let i = 0; i < BUCKET_COUNT; i++) {
      bkts.push({
        idx: i,
        time: effectiveStart + i * bucketMs,
        label: formatBucketLabel(effectiveStart + i * bucketMs),
        ops: 0,
        memMb: 0,
        slowCount: 0,
        slowMaxDuration: 0,
        anomalyCritical: 0,
        anomalyWarning: 0,
        latencyMax: 0,
      });
      evts.push({ slowlogs: [], anomalies: [], latencies: [] });
    }

    const toIdx = (ts: number) => {
      const ms = ts < 1e12 ? ts * 1000 : ts;
      return Math.max(0, Math.min(Math.floor((ms - effectiveStart) / bucketMs), BUCKET_COUNT - 1));
    };

    for (const s of memSnapshots) {
      const i = toIdx(s.timestamp);
      bkts[i].ops = Math.max(bkts[i].ops, s.opsPerSec ?? 0);
      bkts[i].memMb = Math.max(bkts[i].memMb, +(s.usedMemory / 1_048_576).toFixed(1));
    }

    for (const e of slowLogs) {
      const i = toIdx(e.timestamp);
      bkts[i].slowCount++;
      if (e.duration > bkts[i].slowMaxDuration) bkts[i].slowMaxDuration = e.duration;
      evts[i].slowlogs.push(e);
    }

    for (const a of anomalies) {
      const i = toIdx(a.timestamp);
      if ((a.severity || 'warning') === 'critical') bkts[i].anomalyCritical++;
      else bkts[i].anomalyWarning++;
      evts[i].anomalies.push(a);
    }

    for (const l of latencySnapshots) {
      const i = toIdx(l.timestamp);
      if (l.maxLatency > bkts[i].latencyMax) bkts[i].latencyMax = l.maxLatency;
      evts[i].latencies.push(l);
    }

    return { buckets: bkts, bucketEvents: evts };
  }, [effectiveStart, effectiveEnd, memSnapshots, slowLogs, anomalies, latencySnapshots]);

  const timeAgo = (ts: number) => {
    const d = Date.now() - ts;
    if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
    if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
    if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
    return `${Math.round(d / 86_400_000)}d ago`;
  };

  const viewInPage = (page: string) => {
    const params = new URLSearchParams();
    if (propStart) params.set('start', propStart.toString());
    if (propEnd) params.set('end', propEnd.toString());
    const qs = params.toString();
    navigate(`/${page}${qs ? `?${qs}` : ''}`);
  };

  const toMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

  // --- Drag-to-select ---
  const clearDragSelection = useCallback(() => {
    setDragSelection(null);
    if (overlayRef.current) overlayRef.current.style.display = 'none';
  }, []);

  const formatDragTime = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const navigateWithDragRange = (page: string) => {
    if (!dragSelection) return;
    navigate(`/${page}?start=${Math.round(dragSelection.startMs)}&end=${Math.round(dragSelection.endMs)}`);
  };

  const onLanesMouseDown = (e: React.MouseEvent) => {
    const wrapper = lanesWrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < LABEL_WIDTH) return;

    e.preventDefault();
    dragStateRef.current = { active: true, startX: x };
    setDragSelection(null);

    if (overlayRef.current) {
      overlayRef.current.style.display = 'block';
      overlayRef.current.style.left = `${x}px`;
      overlayRef.current.style.width = '0px';
    }

    const wrapperWidth = wrapper.offsetWidth;
    const chartWidth = wrapperWidth - LABEL_WIDTH;
    const rangeMs = effectiveEnd - effectiveStart;
    const toEpoch = (px: number) =>
      effectiveStart + (Math.max(0, Math.min(px - LABEL_WIDTH, chartWidth)) / chartWidth) * rangeMs;

    const onMove = (ev: MouseEvent) => {
      if (!dragStateRef.current.active || !overlayRef.current) return;
      const cx = ev.clientX - rect.left;
      const l = Math.max(LABEL_WIDTH, Math.min(dragStateRef.current.startX, cx));
      const r = Math.min(wrapperWidth, Math.max(dragStateRef.current.startX, cx));
      overlayRef.current.style.left = `${l}px`;
      overlayRef.current.style.width = `${r - l}px`;
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!dragStateRef.current.active) return;
      dragStateRef.current.active = false;

      const endX = ev.clientX - rect.left;
      if (Math.abs(endX - dragStateRef.current.startX) < 5) {
        if (overlayRef.current) overlayRef.current.style.display = 'none';
        return;
      }

      suppressNextClick.current = true;
      const l = Math.max(LABEL_WIDTH, Math.min(dragStateRef.current.startX, endX));
      const r = Math.min(wrapperWidth, Math.max(dragStateRef.current.startX, endX));
      const sMs = toEpoch(l);
      const eMs = toEpoch(r);

      if (eMs - sMs < rangeMs / BUCKET_COUNT) {
        if (overlayRef.current) overlayRef.current.style.display = 'none';
        return;
      }

      if (overlayRef.current) {
        overlayRef.current.style.left = `${l}px`;
        overlayRef.current.style.width = `${r - l}px`;
      }
      setDragSelection({ startMs: sMs, endMs: eMs, left: l, width: r - l });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clearDragSelection(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearDragSelection]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onSlowClick = (_data: any, index: number) => {
    const evts = bucketEvents[index]?.slowlogs;
    if (!evts?.length) return;
    setSelectedEvent({
      type: 'slowlog',
      items: evts.map(e => ({
        timestamp: toMs(e.timestamp),
        command: Array.isArray(e.command) ? e.command.join(' ') : String(e.command),
        duration: e.duration,
        clientAddress: e.clientAddress,
      })),
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onAnomalyClick = (_data: any, index: number) => {
    const evts = bucketEvents[index]?.anomalies;
    if (!evts?.length) return;
    setSelectedEvent({
      type: 'anomaly',
      items: evts.map(a => ({
        timestamp: toMs(a.timestamp),
        severity: a.severity || 'warning',
        metricType: a.metricType || 'unknown',
        zScore: a.zScore ?? 0,
      })),
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onLatencyClick = (_data: any, index: number) => {
    const evts = bucketEvents[index]?.latencies;
    if (!evts?.length) return;
    setSelectedEvent({
      type: 'latency',
      items: evts.map(l => ({
        timestamp: toMs(l.timestamp),
        eventName: l.eventName,
        maxLatency: l.maxLatency,
      })),
    });
  };

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle>Event Timeline</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading timeline data…</p>
        </CardContent>
      </Card>
    );
  }

  const allEmpty = memSnapshots.length === 0 && slowLogs.length === 0
    && anomalies.length === 0 && latencySnapshots.length === 0;

  if (allEmpty) {
    return (
      <Card>
        <CardHeader><CardTitle>Event Timeline</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No events in this time range.</p>
        </CardContent>
      </Card>
    );
  }

  const laneLabel = (text: string) => (
    <div className="w-20 shrink-0 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center">
      {text}
    </div>
  );

  return (
    <Card>
      <CardHeader><CardTitle>Event Timeline</CardTitle></CardHeader>
      <CardContent className="space-y-0 event-timeline-lanes">
        {/* Lanes wrapper with drag-to-select */}
        <div
          ref={lanesWrapperRef}
          className="relative select-none"
          onMouseDown={onLanesMouseDown}
          onClickCapture={(e) => {
            if (suppressNextClick.current) {
              suppressNextClick.current = false;
              e.stopPropagation();
            }
          }}
        >
          {/* Drag overlay */}
          <div
            ref={overlayRef}
            style={{
              display: 'none',
              position: 'absolute',
              top: 0,
              bottom: 0,
              pointerEvents: 'none',
              zIndex: 5,
              background: 'hsl(var(--primary) / 0.12)',
              border: '1px solid hsl(var(--primary) / 0.4)',
              borderRadius: 2,
            }}
          />

        {/* Ops / Mem */}
        <div className="flex items-center">
          {laneLabel('OPS / MEM')}
          <div className="flex-1 min-w-0">
            <ResponsiveContainer width="100%" height={64}>
              <ComposedChart data={buckets} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="idx" tick={false} axisLine={false} tickLine={false} />
                <YAxis yAxisId="ops" hide />
                <YAxis yAxisId="mem" orientation="right" hide />
                <Tooltip
                  wrapperStyle={{ zIndex: 10 }}
                  content={<LaneTooltip fields={[
                    { key: 'ops', label: 'Ops/sec' },
                    { key: 'memMb', label: 'Memory', format: v => `${v.toFixed(1)} MB` },
                  ]} />}
                />
                <Area yAxisId="ops" type="monotone" dataKey="ops" stroke="#8884d8" fill="#8884d8" fillOpacity={0.3} name="ops" />
                <Line yAxisId="mem" type="monotone" dataKey="memMb" stroke="#82ca9d" dot={false} strokeWidth={1.5} name="memMb" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Slow Log */}
        <div className="flex items-center">
          {laneLabel('SLOW LOG')}
          <div className="flex-1 min-w-0">
            <ResponsiveContainer width="100%" height={48}>
              <ComposedChart data={buckets} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="idx" tick={false} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip
                  wrapperStyle={{ zIndex: 10 }}
                  content={<LaneTooltip fields={[{ key: 'slowCount', label: 'Queries' }]} />}
                />
                <Bar dataKey="slowCount" onClick={onSlowClick} cursor="pointer">
                  {buckets.map((b, i) => (
                    <Cell
                      key={i}
                      fill={
                        b.slowMaxDuration >= 500_000 ? '#E24B4A'
                          : b.slowMaxDuration >= 100_000 ? '#EF9F27'
                          : '#8884d8'
                      }
                    />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Anomalies */}
        <div className="flex items-center">
          {laneLabel('ANOMALIES')}
          <div className="flex-1 min-w-0">
            <ResponsiveContainer width="100%" height={48}>
              <ComposedChart data={buckets} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="idx" tick={false} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip
                  wrapperStyle={{ zIndex: 10 }}
                  content={<LaneTooltip fields={[
                    { key: 'anomalyCritical', label: 'Critical' },
                    { key: 'anomalyWarning', label: 'Warning' },
                  ]} />}
                />
                <Bar
                  dataKey="anomalyCritical"
                  stackId="a"
                  barSize={12}
                  onClick={onAnomalyClick}
                  cursor="pointer"
                  fill="#E24B4A"
                  stroke="none"
                />
                <Bar
                  dataKey="anomalyWarning"
                  stackId="a"
                  barSize={12}
                  onClick={onAnomalyClick}
                  cursor="pointer"
                  fill="#EF9F27"
                  stroke="none"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Latency */}
        <div className="flex items-center">
          {laneLabel('LATENCY')}
          <div className="flex-1 min-w-0">
            <ResponsiveContainer width="100%" height={48}>
              <ComposedChart data={buckets} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="idx"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  tickFormatter={(idx: number) => buckets[idx]?.label ?? ''}
                />
                <YAxis hide />
                <Tooltip
                  wrapperStyle={{ zIndex: 10 }}
                  content={<LaneTooltip fields={[
                    { key: 'latencyMax', label: 'Max Latency', format: v => `${(v / 1000).toFixed(1)}ms` },
                  ]} />}
                />
                <Bar
                  dataKey="latencyMax"
                  barSize={8}
                  onClick={onLatencyClick}
                  cursor="pointer"
                  fill="#8884d8"
                  stroke="none"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        </div>{/* end lanes wrapper */}

        {/* Drag selection action bar */}
        {dragSelection && (
          <div className="mt-2 py-2 px-3 rounded-md border bg-muted/50 flex items-center gap-3 flex-wrap">
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatDragTime(dragSelection.startMs)} → {formatDragTime(dragSelection.endMs)}
            </span>
            <div className="flex items-center gap-2">
              <button className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors" onClick={() => navigateWithDragRange('slowlog')}>Open in slow log</button>
              <button className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors" onClick={() => navigateWithDragRange('anomalies')}>Open in anomalies</button>
              <button className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors" onClick={() => navigateWithDragRange('latency')}>Open in latency</button>
              <button className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors" onClick={() => navigateWithDragRange('client-analytics/deep-dive')}>Open in client analytics</button>
            </div>
            <button onClick={clearDragSelection} className="text-muted-foreground hover:text-foreground text-sm ml-auto">✕</button>
          </div>
        )}

        {/* Detail panel */}
        {selectedEvent && (
          <div className="mt-4 p-3 rounded-md border bg-muted/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {selectedEvent.type === 'slowlog' ? 'Slow Queries'
                    : selectedEvent.type === 'anomaly' ? 'Anomalies'
                    : 'Latency Events'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {selectedEvent.items.length} event{selectedEvent.items.length !== 1 ? 's' : ''}
                </span>
              </div>
              <button
                onClick={() => setSelectedEvent(null)}
                className="text-muted-foreground hover:text-foreground text-sm"
              >
                ✕
              </button>
            </div>

            <div className="mt-2 max-h-48 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border/50">
                {selectedEvent.type === 'slowlog' && selectedEvent.items.map((item, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-3 w-1">
                      <span className={`inline-block w-2 h-2 rounded-full ${
                        item.duration >= 500_000 ? 'bg-red-500'
                          : item.duration >= 100_000 ? 'bg-amber-500'
                          : 'bg-blue-500'
                      }`} />
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap font-medium tabular-nums">
                      {(item.duration / 1000).toFixed(1)}ms
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs truncate max-w-[300px]">
                      {item.command.length > 80 ? item.command.slice(0, 80) + '…' : item.command}
                    </td>
                    <td className="py-1.5 text-xs text-muted-foreground whitespace-nowrap text-right">
                      {timeAgo(item.timestamp)}
                    </td>
                  </tr>
                ))}
                {selectedEvent.type === 'anomaly' && selectedEvent.items.map((item, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-3 w-1">
                      <span className={`inline-block w-2 h-2 rounded-full ${
                        item.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'
                      }`} />
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap font-medium capitalize">
                      {item.severity}
                    </td>
                    <td className="py-1.5 pr-3">{item.metricType}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground tabular-nums whitespace-nowrap">
                      z: {item.zScore.toFixed(2)}
                    </td>
                    <td className="py-1.5 text-xs text-muted-foreground whitespace-nowrap text-right">
                      {timeAgo(item.timestamp)}
                    </td>
                  </tr>
                ))}
                {selectedEvent.type === 'latency' && selectedEvent.items.map((item, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-3 w-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap font-medium tabular-nums">
                      {(item.maxLatency / 1000).toFixed(1)}ms
                    </td>
                    <td className="py-1.5 pr-3">{item.eventName}</td>
                    <td className="py-1.5 text-xs text-muted-foreground whitespace-nowrap text-right">
                      {timeAgo(item.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            <div className="mt-2">
              <button
                className="text-sm text-primary hover:underline"
                onClick={() => {
                  const page = selectedEvent.type === 'slowlog' ? 'slowlog'
                    : selectedEvent.type === 'anomaly' ? 'anomalies'
                    : 'latency';
                  viewInPage(page);
                }}
              >
                View all in {selectedEvent.type === 'slowlog' ? 'Slow Log'
                  : selectedEvent.type === 'anomaly' ? 'Anomalies'
                  : 'Latency'} →
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
