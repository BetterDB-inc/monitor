import { createHash } from 'crypto';
import { AnomalyEvent, AnomalyPattern, AnomalySeverity, MetricType } from './types';
import { SequenceRule } from './sequence-rules';
import { SUSTAINED_COOLDOWN_MS, regressedCommands } from '../latency-regression/regression-detector';

export type IncidentScopeResolver = (connectionId: string) => string;

export interface IncidentTimelineEntry {
  anomalyId: string;
  connectionId: string;
  timestamp: number;
  metricType: MetricType;
  severity: AnomalySeverity;
  message: string;
  recoveredAt: number | null;
}

export type IncidentRecoveryStatus = 'active' | 'recovering' | 'recovered' | 'degraded' | 'unknown';

export interface IncidentSequenceMatch {
  pattern: AnomalyPattern;
  anomalyIds: string[];
  diagnosis: string;
  recommendations: string[];
  severity: AnomalySeverity;
}

export interface IncidentTimeline {
  incidentId: string;
  scope: string;
  connectionIds: string[];
  startedAt: number;
  lastEventAt: number;
  entries: IncidentTimelineEntry[];
  sequence: MetricType[];
  matchedPatterns: AnomalyPattern[];
  sequenceMatches: IncidentSequenceMatch[];
  recovery: {
    status: IncidentRecoveryStatus;
    openSignals: MetricType[];
    unknownSignals: MetricType[];
    recoveredAt: number | null;
  };
}

export interface IncidentBoundary {
  scopeId: string;
  startedAt: number;
  anomalyId: string;
}

export interface IncidentTimelineOptions {
  gapMs: number;
  maxSpanMs: number;
  settleMs: number;
  degradedAfterMs: number;
}

export const DEFAULT_INCIDENT_TIMELINE_OPTIONS: IncidentTimelineOptions = {
  gapMs: 120_000,
  maxSpanMs: 30 * 60_000,
  settleMs: 60_000,
  degradedAfterMs: 10 * 60_000,
};

export interface RecoverySignal {
  connectionId: string;
  metricType: MetricType;
  since: number;
  until: number | null;
  baseline: number;
  stdDev: number;
  now: number;
  message: string;
}

export type RecoveryProbe = (signal: RecoverySignal) => number | null | undefined;

export const FLAT_BASELINE_RECOVERY_TOLERANCE = 0.05;

export const MAX_MISSED_RECOVERY_POLLS = 3;

export const POINT_IN_TIME_METRICS: ReadonlySet<MetricType> = new Set([MetricType.COMMAND_P99]);

export const POINT_IN_TIME_QUIET_MS =
  SUSTAINED_COOLDOWN_MS + DEFAULT_INCIDENT_TIMELINE_OPTIONS.settleMs;

export const RESOLVER_BACKED_METRICS: ReadonlySet<MetricType> = new Set([
  MetricType.RAFT_HEALTH,
  MetricType.RESHARD_SHARD_SKEW,
  MetricType.REPLICA_SLOT_STATE,
  MetricType.REPLICATION_DIVERGENCE,
  MetricType.BACKLOG_COVERAGE_RISK,
  MetricType.CLIENT_SATURATION,
  MetricType.RESYNC_ESCALATION,
]);

const SEVERITY_RANK: Record<AnomalySeverity, number> = {
  [AnomalySeverity.INFO]: 0,
  [AnomalySeverity.WARNING]: 1,
  [AnomalySeverity.CRITICAL]: 2,
};

export function maxSeverity(severities: AnomalySeverity[]): AnomalySeverity {
  return severities.reduce(
    (max, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[max] ? s : max),
    AnomalySeverity.INFO,
  );
}

export function incidentIdFor(scope: string, firstAnomalyId: string, startedAt: number): string {
  const hash = createHash('sha256').update(`${scope}\u0000${firstAnomalyId}`).digest('hex');
  return `${startedAt}-${hash.slice(0, 16)}`;
}

export function incidentStartOf(incidentId: string): number | null {
  const match = /^(\d+)-[0-9a-f]{16}$/.exec(incidentId);
  return match ? Number(match[1]) : null;
}

export function matchSequence(
  entries: IncidentTimelineEntry[],
  rule: SequenceRule,
): IncidentTimelineEntry[] | null {
  for (const first of entries) {
    if (!rule.steps[0].includes(first.metricType)) continue;
    const matched = [first];
    for (const step of rule.steps.slice(1)) {
      const previous = matched[matched.length - 1];
      const next = entries.find(
        (e) =>
          !matched.includes(e) &&
          step.includes(e.metricType) &&
          (!rule.sameConnection || e.connectionId === first.connectionId) &&
          e.timestamp >= previous.timestamp &&
          e.timestamp - first.timestamp <= rule.maxSpanMs,
      );
      if (!next) break;
      matched.push(next);
    }
    if (matched.length === rule.steps.length) return matched;
  }
  return null;
}

export function matchSequences(
  entries: IncidentTimelineEntry[],
  rule: SequenceRule,
): IncidentTimelineEntry[][] {
  const matches: IncidentTimelineEntry[][] = [];
  let remaining = entries;
  for (let matched = matchSequence(remaining, rule); matched; matched = matchSequence(remaining, rule)) {
    matches.push(matched);
    const used = matched;
    remaining = remaining.filter((e) => !used.includes(e));
  }
  return matches;
}

export function toTimelineEntry(event: AnomalyEvent): IncidentTimelineEntry {
  return {
    anomalyId: event.id,
    connectionId: event.connectionId ?? '',
    timestamp: event.timestamp,
    metricType: event.metricType,
    severity: event.severity,
    message: event.message,
    recoveredAt: null,
  };
}

function signalKey(event: AnomalyEvent): string {
  const signal = `${event.connectionId ?? ''}\u0000${event.metricType}`;
  return POINT_IN_TIME_METRICS.has(event.metricType)
    ? `${signal}\u0000${regressedCommands(event.message).join(',')}`
    : signal;
}

interface IncidentCluster {
  events: AnomalyEvent[];
  start?: IncidentBoundary;
}

function startsByEvent(boundary: IncidentBoundary, event: AnomalyEvent): boolean {
  return (
    boundary.startedAt < event.timestamp ||
    (boundary.startedAt === event.timestamp && boundary.anomalyId <= event.id)
  );
}

export class IncidentTimelineBuilder {
  private readonly opts: IncidentTimelineOptions;

  constructor(
    opts: Partial<IncidentTimelineOptions> = {},
    private readonly resolveScope: IncidentScopeResolver = (connectionId) => connectionId,
    private readonly rules: () => readonly SequenceRule[] = () => [],
  ) {
    this.opts = { ...DEFAULT_INCIDENT_TIMELINE_OPTIONS, ...opts };
  }

  build(
    events: AnomalyEvent[],
    now: number,
    probe: RecoveryProbe,
    boundaries: readonly IncidentBoundary[] = [],
  ): IncidentTimeline[] {
    const byScope = new Map<string, AnomalyEvent[]>();
    for (const event of events) {
      const connectionId = event.connectionId ?? '';
      const scope = event.scopeId ?? (connectionId ? this.resolveScope(connectionId) : '');
      const bucket = byScope.get(scope);
      if (bucket) bucket.push(event);
      else byScope.set(scope, [event]);
    }

    const signalTimes = new Map<string, number[]>();
    for (const event of events) {
      const key = signalKey(event);
      const times = signalTimes.get(key);
      if (times) times.push(event.timestamp);
      else signalTimes.set(key, [event.timestamp]);
    }
    for (const times of signalTimes.values()) times.sort((a, b) => a - b);
    const nextOccurrence = (event: AnomalyEvent): number | null => {
      const times = signalTimes.get(signalKey(event))!;
      let low = 0;
      let high = times.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (times[middle] > event.timestamp) high = middle;
        else low = middle + 1;
      }
      return times[low] ?? null;
    };

    const timelines: IncidentTimeline[] = [];
    for (const [scope, scoped] of byScope) {
      const sorted = [...scoped].sort(
        (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      const scopedBoundaries = boundaries
        .filter((b) => b.scopeId === scope)
        .sort(
          (a, b) =>
            a.startedAt - b.startedAt ||
            (a.anomalyId < b.anomalyId ? -1 : a.anomalyId > b.anomalyId ? 1 : 0),
        );
      for (const cluster of this.cluster(sorted, scopedBoundaries)) {
        timelines.push(this.toTimeline(scope, cluster, now, probe, nextOccurrence));
      }
    }
    return timelines.sort(
      (a, b) => a.startedAt - b.startedAt || a.incidentId.localeCompare(b.incidentId),
    );
  }

  private cluster(
    sorted: AnomalyEvent[],
    boundaries: readonly IncidentBoundary[],
  ): IncidentCluster[] {
    const clusters: IncidentCluster[] = [];
    let current: AnomalyEvent[] = [];
    let start: IncidentBoundary | undefined;
    let latest: IncidentBoundary | undefined;
    let used: IncidentBoundary | undefined;
    let next = 0;
    for (const event of sorted) {
      while (next < boundaries.length && startsByEvent(boundaries[next], event)) {
        latest = boundaries[next];
        next += 1;
      }
      const stored =
        latest && event.timestamp - latest.startedAt <= this.opts.maxSpanMs ? latest : undefined;
      const first = current[0];
      const continues = first !== undefined && this.continuesIncident(current, event);
      if (
        continues &&
        !start &&
        stored?.anomalyId === event.id &&
        stored !== used &&
        event.timestamp - first.timestamp <= this.opts.maxSpanMs
      ) {
        start = stored;
        used = stored;
      }
      if (
        first &&
        ((stored !== undefined && stored !== used) ||
          !continues ||
          event.timestamp - (start?.startedAt ?? first.timestamp) > this.opts.maxSpanMs)
      ) {
        clusters.push({ events: current, start });
        current = [];
        start = undefined;
      }
      if (current.length === 0 && stored !== undefined && stored !== used) {
        start = stored;
        used = stored;
      }
      current.push(event);
    }
    if (current.length > 0) clusters.push({ events: current, start });
    return clusters;
  }

  private continuesIncident(current: AnomalyEvent[], event: AnomalyEvent): boolean {
    const last = current[current.length - 1];
    if (event.timestamp - last.timestamp <= this.opts.gapMs) return true;
    return this.rules().some((rule) =>
      rule.steps.slice(1).some(
        (step, i) =>
          step.includes(event.metricType) &&
          current.some(
            (earlier) =>
              rule.steps[i].includes(earlier.metricType) &&
              (!rule.sameConnection || earlier.connectionId === event.connectionId) &&
              event.timestamp - earlier.timestamp <= rule.maxSpanMs,
          ),
      ),
    );
  }

  private toTimeline(
    scope: string,
    { events, start }: IncidentCluster,
    now: number,
    probe: RecoveryProbe,
    nextOccurrence: (event: AnomalyEvent) => number | null,
  ): IncidentTimeline {
    const firstBySignal = new Map<string, AnomalyEvent>();
    const lastBySignal = new Map<string, AnomalyEvent>();
    for (const event of events) {
      const key = signalKey(event);
      if (!firstBySignal.has(key)) firstBySignal.set(key, event);
      lastBySignal.set(key, event);
    }
    const recoveredAtBySignal = new Map<string, number | null | undefined>();
    for (const [key, event] of lastBySignal) {
      recoveredAtBySignal.set(
        key,
        this.recoveredAt(event, firstBySignal.get(key)!, nextOccurrence(event), now, probe),
      );
    }

    const entries: IncidentTimelineEntry[] = events.map((event) => {
      const key = signalKey(event);
      const isLast = lastBySignal.get(key) === event;
      return {
        ...toTimelineEntry(event),
        recoveredAt: isLast
          ? (recoveredAtBySignal.get(key) ?? null)
          : this.recoveredAtIfResolved(event),
      };
    });

    const sequence: MetricType[] = [];
    for (const entry of entries) {
      if (!sequence.includes(entry.metricType)) sequence.push(entry.metricType);
    }

    const sequenceMatches: IncidentSequenceMatch[] = [];
    for (const rule of this.rules()) {
      for (const matched of matchSequences(entries, rule)) {
        sequenceMatches.push({
          pattern: rule.pattern,
          anomalyIds: matched.map((e) => e.anomalyId),
          diagnosis: rule.diagnosis,
          recommendations: rule.recommendations,
          severity: maxSeverity(matched.map((e) => e.severity)),
        });
      }
    }

    const openSignals: MetricType[] = [];
    const unknownSignals: MetricType[] = [];
    let recoveredAt: number | null = null;
    for (const [key, at] of recoveredAtBySignal) {
      const metricType = lastBySignal.get(key)!.metricType;
      if (at === null) {
        if (!openSignals.includes(metricType)) openSignals.push(metricType);
      } else if (at === undefined) {
        if (!unknownSignals.includes(metricType)) unknownSignals.push(metricType);
      } else if (recoveredAt === null || at > recoveredAt) {
        recoveredAt = at;
      }
    }

    const lastEventAt = events[events.length - 1].timestamp;
    const anchoredAt = start?.startedAt ?? events[0].timestamp;

    return {
      incidentId: incidentIdFor(scope, start?.anomalyId ?? events[0].id, anchoredAt),
      scope,
      connectionIds: [...new Set(entries.map((e) => e.connectionId))],
      startedAt: Math.min(anchoredAt, events[0].timestamp),
      lastEventAt,
      entries,
      sequence,
      matchedPatterns: sequenceMatches.map((m) => m.pattern),
      sequenceMatches,
      recovery: {
        status: this.status(now, lastEventAt, openSignals.length, unknownSignals.length),
        openSignals,
        unknownSignals,
        recoveredAt: openSignals.length === 0 && unknownSignals.length === 0 ? recoveredAt : null,
      },
    };
  }

  private recoveredAtIfResolved(event: AnomalyEvent): number | null {
    return event.resolved ? (event.resolvedAt ?? event.timestamp) : null;
  }

  private recoveredAt(
    event: AnomalyEvent,
    first: AnomalyEvent,
    until: number | null,
    now: number,
    probe: RecoveryProbe,
  ): number | null | undefined {
    if (event.resolved) return event.resolvedAt ?? event.timestamp;
    if (now - event.timestamp < this.opts.settleMs) return null;
    return probe({
      connectionId: event.connectionId ?? '',
      metricType: event.metricType,
      since: event.timestamp,
      until,
      baseline: first.baseline,
      stdDev: first.stdDev,
      now,
      message: event.message,
    });
  }

  private status(
    now: number,
    lastEventAt: number,
    openCount: number,
    unknownCount: number,
  ): IncidentRecoveryStatus {
    const quietFor = now - lastEventAt;
    if (quietFor < this.opts.gapMs) return 'active';
    if (openCount === 0) return unknownCount === 0 ? 'recovered' : 'unknown';
    return quietFor >= this.opts.degradedAfterMs ? 'degraded' : 'recovering';
  }
}
