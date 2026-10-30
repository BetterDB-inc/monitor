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

export type IncidentRecoveryStatus = 'active' | 'recovering' | 'recovered' | 'degraded';

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

export type RecoveryProbe = (
  connectionId: string,
  metricType: MetricType,
  since: number,
) => number | null;

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

export function incidentIdFor(scope: string, firstAnomalyId: string): string {
  return createHash('sha256').update(`${scope}\u0000${firstAnomalyId}`).digest('hex').slice(0, 24);
}

export function matchSequence(
  entries: IncidentTimelineEntry[],
  rule: SequenceRule,
): IncidentTimelineEntry[] | null {
  for (let start = 0; start < entries.length; start++) {
    if (!rule.steps[0].includes(entries[start].metricType)) continue;
    const matched = [entries[start]];
    let step = 1;
    for (let i = start + 1; i < entries.length && step < rule.steps.length; i++) {
      if (entries[i].timestamp - entries[start].timestamp > rule.maxSpanMs) break;
      if (rule.steps[step].includes(entries[i].metricType)) {
        matched.push(entries[i]);
        step++;
      }
    }
    if (step === rule.steps.length) return matched;
  }
  return null;
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

    const timelines: IncidentTimeline[] = [];
    for (const [scope, scoped] of byScope) {
      const sorted = [...scoped].sort(
        (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      for (const cluster of this.cluster(sorted)) {
        timelines.push(this.toTimeline(scope, cluster, now, probe));
      }
    }
    return timelines.sort((a, b) => a.startedAt - b.startedAt || a.incidentId.localeCompare(b.incidentId));
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
  ): IncidentTimeline {
    const lastBySignal = new Map<string, AnomalyEvent>();
    for (const event of events) {
      lastBySignal.set(`${event.connectionId ?? ''}\u0000${event.metricType}`, event);
    }
    const recoveredAtBySignal = new Map<string, number | null>();
    for (const [key, event] of lastBySignal) {
      recoveredAtBySignal.set(key, this.recoveredAt(event, now, probe));
    }

    const entries: IncidentTimelineEntry[] = events.map((event) => {
      const key = `${event.connectionId ?? ''}\u0000${event.metricType}`;
      const isLast = lastBySignal.get(key) === event;
      return {
        anomalyId: event.id,
        connectionId: event.connectionId ?? '',
        timestamp: event.timestamp,
        metricType: event.metricType,
        severity: event.severity,
        message: event.message,
        recoveredAt: isLast ? (recoveredAtBySignal.get(key) ?? null) : this.recoveredAtIfResolved(event),
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
    let recoveredAt: number | null = null;
    for (const [key, at] of recoveredAtBySignal) {
      const metricType = lastBySignal.get(key)!.metricType;
      if (at === null) {
        if (!openSignals.includes(metricType)) openSignals.push(metricType);
      } else if (recoveredAt === null || at > recoveredAt) {
        recoveredAt = at;
      }
    }

    const lastEventAt = events[events.length - 1].timestamp;

    return {
      incidentId: incidentIdFor(scope, events[0].id),
      scope,
      connectionIds: [...new Set(entries.map((e) => e.connectionId))],
      startedAt: events[0].timestamp,
      lastEventAt,
      entries,
      sequence,
      matchedPatterns: sequenceMatches.map((m) => m.pattern),
      sequenceMatches,
      recovery: {
        status: this.status(now, lastEventAt, openSignals.length),
        openSignals,
        recoveredAt: openSignals.length === 0 ? recoveredAt : null,
      },
    };
  }

  private recoveredAtIfResolved(event: AnomalyEvent): number | null {
    return event.resolved ? (event.resolvedAt ?? event.timestamp) : null;
  }

  private recoveredAt(event: AnomalyEvent, now: number, probe: RecoveryProbe): number | null {
    if (event.resolved) return event.resolvedAt ?? event.timestamp;
    if (now - event.timestamp < this.opts.settleMs) return null;
    return probe(event.connectionId ?? '', event.metricType, event.timestamp);
  }

  private status(now: number, lastEventAt: number, openCount: number): IncidentRecoveryStatus {
    const quietFor = now - lastEventAt;
    if (quietFor < this.opts.gapMs) return 'active';
    if (openCount === 0) return 'recovered';
    return quietFor >= this.opts.degradedAfterMs ? 'degraded' : 'recovering';
  }
}
