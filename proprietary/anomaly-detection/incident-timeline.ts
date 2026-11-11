import type { RegressionKind } from '../latency-regression/types';
import { createHash } from 'crypto';
import {
  AnomalyEvent,
  AnomalyPattern,
  AnomalySeverity,
  MetricType,
  RecommendationValue,
  mergeRecommendationValues,
} from './types';
import { SequenceRule, fills, leadOf, opensAt } from './sequence-rules';
import { SUSTAINED_COOLDOWN_MS } from '../latency-regression/regression-detector';

export type IncidentScopeResolver = (connectionId: string) => string;

export interface IncidentTimelineEntry {
  anomalyId: string;
  connectionId: string;
  nodeAddr?: string;
  timestamp: number;
  metricType: MetricType;
  severity: AnomalySeverity;
  message: string;
  recoveredAt: number | null;
  recoveryState: IncidentEntryRecovery;
  values?: RecommendationValue[];
}

export type IncidentEntryRecovery = 'recovered' | 'open' | 'unknown' | 'recurred';

type SignalRecovery =
  | { state: 'recovered'; at: number }
  | { state: 'open' }
  | { state: 'unknown' };

export type IncidentRecoveryStatus = 'active' | 'recovering' | 'recovered' | 'degraded' | 'unknown';

export interface IncidentSequenceStep {
  anomalyId: string;
  step: number | null;
}

export interface IncidentSequenceMatch {
  pattern: AnomalyPattern;
  anomalyIds: string[];
  steps: IncidentSequenceStep[];
  diagnosis: string;
  recommendations: string[];
  values?: RecommendationValue[];
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

export type RuleStepEvent = Pick<AnomalyEvent, 'metricType' | 'connectionId' | 'nodeAddr' | 'timestamp'> &
  Partial<Pick<AnomalyEvent, 'anomalyType' | 'retryTrigger'>>;

type EventSource = Pick<AnomalyEvent, 'connectionId' | 'nodeAddr'>;

export function sameSource(a: EventSource, b: EventSource): boolean {
  return a.connectionId === b.connectionId && (a.nodeAddr ?? '') === (b.nodeAddr ?? '');
}

function sourceKey(event: EventSource): string {
  return event.nodeAddr
    ? `${event.connectionId ?? ''}\u0000${event.nodeAddr}`
    : (event.connectionId ?? '');
}

export interface IncidentBoundary {
  scopeId: string;
  startedAt: number;
  anomalyId: string;
  metricType?: string;
  connectionId?: string;
  members?: RuleStepEvent[];
}

export interface DroppedSpan {
  from: number;
  through: number;
  scopeId?: string;
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
  threshold: number;
  now: number;
  kind?: RegressionKind;
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
  MetricType.HOT_SHARD,
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

export function mergeRuleSteps(
  known: readonly RuleStepEvent[],
  seen: readonly RuleStepEvent[],
): RuleStepEvent[] {
  const steps = new Map<string, RuleStepEvent>();
  for (const step of [...known, ...seen]) {
    steps.set(`${step.metricType}\u0000${sourceKey(step)}\u0000${step.timestamp}`, step);
  }
  return [...steps.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function incidentIdFor(scope: string, firstAnomalyId: string, startedAt: number): string {
  const hash = createHash('sha256').update(`${scope}\u0000${firstAnomalyId}`).digest('hex');
  return `${startedAt}-${hash.slice(0, 16)}`;
}

export function incidentStartOf(incidentId: string): number | null {
  const match = /^(\d+)-[0-9a-f]{16}$/.exec(incidentId);
  return match ? Number(match[1]) : null;
}

export function stepNumberOf(rule: SequenceRule, matched: readonly RuleStepEvent[], position: number): number | null {
  const opened = opensAt(rule, matched[0]) ?? 0;
  return position < rule.steps.length - opened ? position + opened + 1 : null;
}

export function requiredOf<E extends RuleStepEvent>(rule: SequenceRule, matched: readonly E[]): E[] {
  return matched.slice(0, rule.steps.length - (opensAt(rule, matched[0]) ?? 0));
}

export function matchSequence<E extends RuleStepEvent>(
  entries: E[],
  rule: SequenceRule,
  accept: (matched: E[]) => boolean = () => true,
): E[] | null {
  const extend = (matched: E[], opened: number): E[] | 'unreachable' | 'rejected' => {
    const index = matched.length + opened;
    if (index === rule.steps.length) return accept(matched) ? matched : 'rejected';
    const first = matched[0];
    const reached = Math.max(...matched.map((e) => e.timestamp));
    const earliest = Math.min(...matched.map((e) => e.timestamp));
    const step = rule.steps[index];
    const lead = leadOf(rule, index);
    const options = entries.filter(
      (e) =>
        !matched.includes(e) &&
        fills(rule, step, e) &&
        (!rule.sameConnection || sameSource(e, first)) &&
        e.timestamp >= reached - lead &&
        Math.max(reached, e.timestamp) - Math.min(earliest, e.timestamp) <= rule.maxSpanMs,
    );
    let outcome: 'unreachable' | 'rejected' = 'unreachable';
    for (const next of options) {
      const found = extend([...matched, next], opened);
      if (found === 'unreachable') {
        if (lead === 0) break;
        continue;
      }
      if (found !== 'rejected') return found;
      outcome = 'rejected';
    }
    return outcome;
  };

  for (const first of entries) {
    const opened = opensAt(rule, first);
    if (opened === null) continue;
    const matched = extend([first], opened);
    if (typeof matched === 'string') continue;
    const optional = entries.filter(
      (e) =>
        !matched.includes(e) &&
        fills(rule, rule.optionalMetrics, e) &&
        (!rule.sameConnection || sameSource(e, first)) &&
        Math.abs(e.timestamp - first.timestamp) <= rule.maxSpanMs,
    );
    return [...matched, ...optional];
  }
  return null;
}

export function reachesStep(
  earlier: readonly RuleStepEvent[],
  event: RuleStepEvent,
  rule: SequenceRule,
  stepIndex: number,
): boolean {
  const candidates = earlier
    .filter(
      (e) =>
        e.timestamp <= event.timestamp &&
        (!rule.sameConnection || sameSource(e, event)),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  return candidates.some((first) => {
    const opened = opensAt(rule, first);
    if (opened === null || opened >= stepIndex) return false;
    if (event.timestamp - first.timestamp > rule.maxSpanMs) return false;
    const used: RuleStepEvent[] = [first];
    let reached = first.timestamp;
    let earliest = first.timestamp;
    for (let i = opened + 1; i < stepIndex; i++) {
      const lead = leadOf(rule, i);
      const next = candidates.find(
        (e) =>
          !used.includes(e) &&
          fills(rule, rule.steps[i], e) &&
          e.timestamp >= reached - lead &&
          event.timestamp - Math.min(earliest, e.timestamp) <= rule.maxSpanMs,
      );
      if (!next) return false;
      used.push(next);
      reached = Math.max(reached, next.timestamp);
      earliest = Math.min(earliest, next.timestamp);
    }
    return true;
  });
}

export function matchedBefore(
  earlier: readonly RuleStepEvent[],
  event: RuleStepEvent,
  rule: SequenceRule,
): boolean {
  const pool = earlier.filter(
    (e) => e.timestamp <= event.timestamp && (!rule.sameConnection || sameSource(e, event)),
  );
  return matchSequence(pool, rule, (matched) => event.timestamp - matched[0].timestamp <= rule.maxSpanMs) !== null;
}

export function precedesLeadStep(
  earlier: readonly RuleStepEvent[],
  event: RuleStepEvent,
  rule: SequenceRule,
): boolean {
  return rule.steps.some((step, i) => {
    const lead = Math.min(leadOf(rule, i), rule.maxSpanMs);
    return (
      lead > 0 &&
      earlier.some(
        (e) =>
          fills(rule, step, e) &&
          (!rule.sameConnection || sameSource(e, event)) &&
          e.timestamp <= event.timestamp &&
          event.timestamp - e.timestamp <= lead,
      )
    );
  });
}

export function matchSequences<E extends RuleStepEvent>(
  entries: E[],
  rule: SequenceRule,
  accept?: (matched: E[]) => boolean,
): E[][] {
  const matches: E[][] = [];
  let remaining = entries;
  for (
    let matched = matchSequence(remaining, rule, accept);
    matched;
    matched = matchSequence(remaining, rule, accept)
  ) {
    matches.push(matched);
    const used = requiredOf(rule, matched);
    remaining = remaining.filter((e) => !used.includes(e));
  }
  return matches;
}

export function toTimelineEntry(event: AnomalyEvent): IncidentTimelineEntry {
  return {
    anomalyId: event.id,
    connectionId: event.connectionId ?? '',
    ...(event.nodeAddr ? { nodeAddr: event.nodeAddr } : {}),
    timestamp: event.timestamp,
    metricType: event.metricType,
    severity: event.severity,
    message: event.message,
    recoveredAt: null,
    recoveryState: 'open',
    ...(event.values ? { values: event.values } : {}),
  };
}

function byEventOrder(a: AnomalyEvent, b: AnomalyEvent): number {
  const unstamped = Number.MAX_SAFE_INTEGER;
  return (
    a.timestamp - b.timestamp ||
    (a.eventSequence ?? unstamped) - (b.eventSequence ?? unstamped) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function signalKey(event: AnomalyEvent): string {
  const signal = `${sourceKey(event)}\u0000${event.metricType}`;
  return POINT_IN_TIME_METRICS.has(event.metricType)
    ? `${signal}\u0000${(event.commands ?? []).join(',')}`
    : signal;
}

interface IncidentCluster {
  events: AnomalyEvent[];
  start?: IncidentBoundary;
  prefix: RuleStepEvent[];
}

function positionsOf(sorted: AnomalyEvent[]): (anomalyId: string) => number {
  const positions = new Map(sorted.map((event, i) => [event.id, i]));
  return (anomalyId) => positions.get(anomalyId) ?? -1;
}

function startsByEvent(
  boundary: IncidentBoundary,
  event: AnomalyEvent,
  positionOf: (anomalyId: string) => number,
): boolean {
  return (
    boundary.startedAt < event.timestamp ||
    (boundary.startedAt === event.timestamp &&
      positionOf(boundary.anomalyId) <= positionOf(event.id))
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
    droppedThrough: ReadonlyMap<string, number> = new Map(),
    heldFrom = Number.NEGATIVE_INFINITY,
    droppedSpans: ReadonlyMap<string, readonly DroppedSpan[]> = new Map(),
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
      const sorted = [...scoped].sort(byEventOrder);
      const positionOf = positionsOf(sorted);
      const scopedBoundaries = boundaries
        .filter((b) => b.scopeId === scope)
        .sort(
          (a, b) =>
            a.startedAt - b.startedAt ||
            positionOf(a.anomalyId) - positionOf(b.anomalyId) ||
            (a.anomalyId < b.anomalyId ? -1 : a.anomalyId > b.anomalyId ? 1 : 0),
        );
      const droppedAt = Math.max(
        heldFrom,
        this.droppedThroughScope(scope, scoped, droppedThrough),
      );
      const spans = this.droppedSpansOf(scope, scoped, droppedSpans);
      for (const cluster of this.cluster(sorted, scopedBoundaries, positionOf, droppedAt, spans)) {
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
    positionOf: (anomalyId: string) => number,
    droppedAt: number,
    spans: DroppedSpan[],
  ): IncidentCluster[] {
    const clusters: IncidentCluster[] = [];
    let current: AnomalyEvent[] = [];
    let start: IncidentBoundary | undefined;
    let latest: IncidentBoundary | undefined;
    let used: IncidentBoundary | undefined;
    let prefix: RuleStepEvent[] = [];
    let next = 0;
    for (const event of sorted) {
      while (next < boundaries.length && startsByEvent(boundaries[next], event, positionOf)) {
        latest = boundaries[next];
        next += 1;
      }
      const stored =
        latest && event.timestamp - latest.startedAt <= this.opts.maxSpanMs ? latest : undefined;
      const first = current[0];
      const continues =
        first !== undefined && this.continuesIncident(prefix, current, event, spans);
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
        clusters.push({ events: current, start, prefix });
        current = [];
        start = undefined;
        prefix = [];
      }
      if (current.length === 0 && stored !== undefined && stored !== used) {
        const anchorDroppedAt = this.anchorDroppedAt(stored, droppedAt, spans);
        const dropped = this.droppedPrefix(stored, anchorDroppedAt);
        const anchorDropped =
          positionOf(stored.anomalyId) < 0 &&
          stored.startedAt <= anchorDroppedAt &&
          (event.timestamp - anchorDroppedAt <= this.opts.gapMs ||
            this.followsRuleStep(dropped, event));
        if (anchorDropped) prefix = dropped;
        if (
          anchorDropped ||
          stored.anomalyId === event.id ||
          event.timestamp - stored.startedAt <= this.opts.gapMs
        ) {
          start = stored;
        }
        used = stored;
      }
      current.push(event);
    }
    if (current.length > 0) clusters.push({ events: current, start, prefix });
    return clusters;
  }

  private anchorDroppedAt(
    stored: IncidentBoundary,
    droppedAt: number,
    spans: readonly DroppedSpan[],
  ): number {
    const covered = spans.some(
      (span) => span.from <= stored.startedAt && stored.startedAt <= span.through,
    );
    return covered ? Math.max(droppedAt, this.spanReach(spans, stored.startedAt)) : droppedAt;
  }

  private droppedThroughScope(
    scope: string,
    events: AnomalyEvent[],
    droppedThrough: ReadonlyMap<string, number>,
  ): number {
    const members = new Set(events.map((event) => event.connectionId ?? ''));
    let latest = Number.NEGATIVE_INFINITY;
    for (const [connectionId, droppedAt] of droppedThrough) {
      if (members.has(connectionId) || this.resolveScope(connectionId) === scope) {
        latest = Math.max(latest, droppedAt);
      }
    }
    return latest;
  }

  private droppedSpansOf(
    scope: string,
    events: AnomalyEvent[],
    droppedSpans: ReadonlyMap<string, readonly DroppedSpan[]>,
  ): DroppedSpan[] {
    const members = new Set(events.map((event) => event.connectionId ?? ''));
    return [...droppedSpans]
      .filter(([connectionId]) => members.has(connectionId) || this.resolveScope(connectionId) === scope)
      .flatMap(([, spans]) => spans)
      .filter((span) => span.scopeId === undefined || span.scopeId === scope)
      .sort((a, b) => a.from - b.from);
  }

  private spanReach(spans: readonly DroppedSpan[], from: number): number {
    let reach = from;
    for (const span of spans) {
      if (span.from - reach > this.opts.gapMs) break;
      reach = Math.max(reach, span.through);
    }
    return reach;
  }

  private bridges(spans: readonly DroppedSpan[], from: number, to: number): boolean {
    const reach = this.spanReach(spans, from);
    return reach > from && to - reach <= this.opts.gapMs;
  }

  private droppedPrefix(stored: IncidentBoundary, droppedAt: number): RuleStepEvent[] {
    const dropped = (stored.members ?? []).filter((member) => member.timestamp <= droppedAt);
    const isAnchor = (member: RuleStepEvent) =>
      member.metricType === stored.metricType &&
      member.connectionId === stored.connectionId &&
      member.timestamp === stored.startedAt;
    const anchor: RuleStepEvent[] =
      stored.metricType === undefined || dropped.some(isAnchor)
        ? []
        : [
            {
              metricType: stored.metricType as MetricType,
              connectionId: stored.connectionId,
              timestamp: stored.startedAt,
            },
          ];
    return [...anchor, ...dropped];
  }

  private continuesIncident(
    prefix: readonly RuleStepEvent[],
    current: readonly RuleStepEvent[],
    event: AnomalyEvent,
    spans: DroppedSpan[] = [],
  ): boolean {
    const last = current[current.length - 1];
    if (event.timestamp - last.timestamp <= this.opts.gapMs) return true;
    if (this.bridges(spans, last.timestamp, event.timestamp)) return true;
    return this.followsRuleStep([...prefix, ...current], event);
  }

  private followsRuleStep(current: readonly RuleStepEvent[], event: AnomalyEvent): boolean {
    return this.rules().some(
      (rule) =>
        rule.steps.some(
          (step, i) =>
            fills(rule, step, event) &&
            (i === 0
              ? precedesLeadStep(current, event, rule)
              : reachesStep(current, event, rule, i) ||
                (leadOf(rule, i) > 0 && reachesStep(current, event, rule, i - 1))),
        ) ||
        (fills(rule, rule.optionalMetrics, event) && matchedBefore(current, event, rule)),
    );
  }

  private toTimeline(
    scope: string,
    { events, start, prefix }: IncidentCluster,
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
    const recoveryBySignal = new Map<string, SignalRecovery>();
    for (const [key, event] of lastBySignal) {
      recoveryBySignal.set(
        key,
        this.signalRecovery(event, firstBySignal.get(key)!, nextOccurrence(event), now, probe),
      );
    }

    const entries: IncidentTimelineEntry[] = events.map((event) => {
      const key = signalKey(event);
      const entry = toTimelineEntry(event);
      if (lastBySignal.get(key) !== event) {
        if (!event.resolved) return { ...entry, recoveryState: 'recurred' };
        return typeof event.resolvedAt === 'number'
          ? { ...entry, recoveredAt: event.resolvedAt, recoveryState: 'recovered' }
          : { ...entry, recoveryState: 'unknown' };
      }
      const recovery = recoveryBySignal.get(key)!;
      return recovery.state === 'recovered'
        ? { ...entry, recoveredAt: recovery.at, recoveryState: 'recovered' }
        : { ...entry, recoveryState: recovery.state };
    });

    const sequence: MetricType[] = [];
    for (const entry of entries) {
      if (!sequence.includes(entry.metricType)) sequence.push(entry.metricType);
    }

    type Candidate = IncidentTimelineEntry & Pick<RuleStepEvent, 'anomalyType' | 'retryTrigger'>;
    const dropped = prefix.map(
      (step): Candidate => ({
        anomalyId: '',
        connectionId: step.connectionId ?? '',
        timestamp: step.timestamp,
        metricType: step.metricType,
        ...(step.nodeAddr ? { nodeAddr: step.nodeAddr } : {}),
        ...(step.anomalyType ? { anomalyType: step.anomalyType } : {}),
        ...(step.retryTrigger ? { retryTrigger: step.retryTrigger } : {}),
        severity: AnomalySeverity.INFO,
        message: '',
        recoveredAt: null,
        recoveryState: 'open',
      }),
    );
    const typed = entries.map(
      (entry, i): Candidate => ({
        ...entry,
        anomalyType: events[i].anomalyType,
        ...(events[i].retryTrigger ? { retryTrigger: events[i].retryTrigger } : {}),
      }),
    );
    const candidates = [...dropped, ...typed].sort((a, b) => a.timestamp - b.timestamp);
    const found: { rule: SequenceRule; matched: Candidate[]; match: IncidentSequenceMatch }[] = [];
    for (const rule of this.rules()) {
      const holdsStep = (matched: Candidate[]) =>
        matched.some((e) => !dropped.includes(e) && rule.steps.some((step) => fills(rule, step, e)));
      for (const matched of matchSequences(candidates, rule, holdsStep)) {
        const live = matched.filter((e) => !dropped.includes(e));
        found.push({
          rule,
          matched,
          match: {
            pattern: rule.pattern,
            anomalyIds: live.map((e) => e.anomalyId),
            steps: live.map((e) => ({
              anomalyId: e.anomalyId,
              step: stepNumberOf(rule, matched, matched.indexOf(e)),
            })),
            diagnosis: rule.diagnosis,
            recommendations: rule.recommendations,
            severity: maxSeverity(live.map((e) => e.severity)),
          },
        });
      }
    }
    const superseded = ({ rule, match, matched }: (typeof found)[number]) => {
      const required = requiredOf(rule, matched);
      return found.some(
        (other) =>
          other.rule.supersedes?.includes(match.pattern) &&
          requiredOf(other.rule, other.matched).some((e) => required.includes(e)),
      );
    };
    const sequenceMatches: IncidentSequenceMatch[] = [];
    const recommendedBy = new Map<string, AnomalyPattern>();
    for (const { match, matched } of found.filter((f) => !superseded(f))) {
      const recommendations = match.recommendations.filter(
        (r) => (recommendedBy.get(r) ?? match.pattern) === match.pattern,
      );
      const values = mergeRecommendationValues(
        matched
          .filter((e) => !dropped.includes(e))
          .sort((a, b) => a.timestamp - b.timestamp || a.anomalyId.localeCompare(b.anomalyId)),
      ).filter((value) => {
        const name = value.setting.split(' ')[0];
        return recommendations.some((recommendation) => recommendation.includes(name));
      });
      sequenceMatches.push({
        ...match,
        recommendations,
        ...(values.length > 0 ? { values } : {}),
      });
      for (const r of match.recommendations) {
        if (!recommendedBy.has(r)) recommendedBy.set(r, match.pattern);
      }
    }

    const openSignals: MetricType[] = [];
    const unknownSignals: MetricType[] = [];
    let recoveredAt: number | null = null;
    for (const [key, recovery] of recoveryBySignal) {
      const metricType = lastBySignal.get(key)!.metricType;
      if (recovery.state === 'open') {
        if (!openSignals.includes(metricType)) openSignals.push(metricType);
      } else if (recovery.state === 'unknown') {
        if (!unknownSignals.includes(metricType)) unknownSignals.push(metricType);
      } else if (recoveredAt === null || recovery.at > recoveredAt) {
        recoveredAt = recovery.at;
      }
    }

    const lastEventAt = events[events.length - 1].timestamp;
    const anchoredAt = start?.startedAt ?? events[0].timestamp;

    return {
      incidentId: incidentIdFor(scope, start?.anomalyId ?? events[0].id, anchoredAt),
      scope,
      connectionIds: [...new Set(entries.map((e) => e.connectionId))].filter((id) => id !== ''),
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
        recoveredAt:
          openSignals.length === 0 && unknownSignals.length === 0 ? recoveredAt : null,
      },
    };
  }

  private signalRecovery(
    event: AnomalyEvent,
    first: AnomalyEvent,
    until: number | null,
    now: number,
    probe: RecoveryProbe,
  ): SignalRecovery {
    if (event.resolved) {
      return typeof event.resolvedAt === 'number'
        ? { state: 'recovered', at: event.resolvedAt }
        : { state: 'unknown' };
    }
    if (now - event.timestamp < this.opts.settleMs) return { state: 'open' };
    const at = probe({
      connectionId: event.connectionId ?? '',
      metricType: event.metricType,
      since: event.timestamp,
      until,
      baseline: first.baseline,
      stdDev: first.stdDev,
      threshold: first.threshold,
      now,
      kind: event.kind,
    });
    if (at === undefined) return { state: 'unknown' };
    return at === null ? { state: 'open' } : { state: 'recovered', at };
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
