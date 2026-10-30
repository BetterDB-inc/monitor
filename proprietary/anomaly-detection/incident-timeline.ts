import { createHash } from 'crypto';
import { AnomalyEvent, AnomalyPattern, AnomalySeverity, MetricType } from './types';
import { SequenceRule } from './sequence-rules';

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
}

export type RecoveryProbe = (signal: RecoverySignal) => number | null | undefined;

export const FLAT_BASELINE_RECOVERY_TOLERANCE = 0.05;

export const MAX_MISSED_RECOVERY_POLLS = 3;

export const POINT_IN_TIME_METRICS: ReadonlySet<MetricType> = new Set([MetricType.COMMAND_P99]);

export const UNTRACKED_RECOVERY_METRICS: ReadonlySet<MetricType> = new Set([
  MetricType.REPLICATION_ROLE,
  MetricType.CLUSTER_STATE,
  MetricType.CONNECTION_CHURN,
  MetricType.REJECTED_CONNECTIONS,
  MetricType.EVICTED_CLIENTS,
  MetricType.SLOWLOG_LAST_ID,
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
  return `${event.connectionId ?? ''}\u0000${event.metricType}`;
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

  build(events: AnomalyEvent[], now: number, probe: RecoveryProbe): IncidentTimeline[] {
    const byScope = new Map<string, AnomalyEvent[]>();
    for (const event of events) {
      const connectionId = event.connectionId ?? '';
      const scope = connectionId ? this.resolveScope(connectionId) : '';
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
    const nextOccurrence = (event: AnomalyEvent): number | null =>
      signalTimes
        .get(signalKey(event))!
        .reduce<
          number | null
        >((next, t) => (t > event.timestamp && (next === null || t < next) ? t : next), null);

    const timelines: IncidentTimeline[] = [];
    for (const [scope, scoped] of byScope) {
      const sorted = [...scoped].sort(
        (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      for (const cluster of this.cluster(sorted)) {
        timelines.push(this.toTimeline(scope, cluster, now, probe, nextOccurrence));
      }
    }
    return timelines.sort(
      (a, b) => a.startedAt - b.startedAt || a.incidentId.localeCompare(b.incidentId),
    );
  }

  private cluster(sorted: AnomalyEvent[]): AnomalyEvent[][] {
    const clusters: AnomalyEvent[][] = [];
    let current: AnomalyEvent[] = [];
    for (const event of sorted) {
      const first = current[0];
      const last = current[current.length - 1];
      if (
        first &&
        (event.timestamp - last.timestamp > this.opts.gapMs ||
          event.timestamp - first.timestamp > this.opts.maxSpanMs)
      ) {
        clusters.push(current);
        current = [];
      }
      current.push(event);
    }
    if (current.length > 0) clusters.push(current);
    return clusters;
  }

  private toTimeline(
    scope: string,
    events: AnomalyEvent[],
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
      const matched = matchSequence(entries, rule);
      if (!matched) continue;
      sequenceMatches.push({
        pattern: rule.pattern,
        anomalyIds: matched.map((e) => e.anomalyId),
        diagnosis: rule.diagnosis,
        recommendations: rule.recommendations,
        severity: maxSeverity(matched.map((e) => e.severity)),
      });
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

    return {
      incidentId: incidentIdFor(scope, events[0].id, events[0].timestamp),
      scope,
      connectionIds: [...new Set(entries.map((e) => e.connectionId))],
      startedAt: events[0].timestamp,
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
