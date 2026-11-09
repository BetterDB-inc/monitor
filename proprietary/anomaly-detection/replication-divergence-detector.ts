import { formatBytes } from '@app/scaling-readiness/dimension-inputs';
import type { ReplicaViewStatus } from '@app/common/interfaces/storage-port.interface';
import { median } from '../latency-regression/regression-detector';
import { ReplicationStreamSample } from './replication-stream';
import { MetricType } from './types';

export const DIVERGENCE_MIN_WINDOW_MS = 30_000;
export const DIVERGENCE_MIN_SAMPLES = 3;
const DIVERGENCE_OUTAGE_GAP_FACTOR = 2;
export const DIVERGENCE_GROWTH_WINDOWS = 4;
export const DIVERGENCE_FLOOR_BYTES = 1024 * 1024;
export const DIVERGENCE_IDLE_BYTES_PER_SEC = 4096;
export const DIVERGENCE_FLOOR_SECONDS = 5;
export const DIVERGENCE_WARN_SECONDS = 30;
export const DIVERGENCE_CRIT_SECONDS = 120;
export const DIVERGENCE_CEILING_WINDOWS = 2;
export const DIVERGENCE_SUBSIDED_RATE_FACTOR = 1.2;
export const DIVERGENCE_BASELINE_WINDOWS = 10;
export const DIVERGENCE_RECOVERY_GRACE_WINDOWS = 4;
export const DIVERGENCE_RECOVERY_SHRINK_FRACTION = 0.5;
export const DIVERGENCE_RECOVERY_HORIZON_WINDOWS = 8;
export const DIVERGENCE_RECOVERED_WINDOWS = 2;
export const DIVERGENCE_HISTORY_WINDOWS = 120;
export const DIVERGENCE_STALE_ACK_SEC = 10;
export const DIVERGENCE_PERSIST_BACKLOG = 1000;
export const OPEN_EVENT_PAGE_SIZE = 500;
export const DIVERGENCE_HISTORY_QUERY_WINDOWS = 2880;
export const DIVERGENCE_WINDOW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DIVERGENCE_WINDOW_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const DIVERGENCE_STALE_WARN_WINDOWS = 2;
export const DIVERGENCE_STALE_CRIT_WINDOWS = 4;
export const DIVERGENCE_DISAGREE_WINDOWS = 3;

export type DivergenceLevel = 'none' | 'warning' | 'critical';
export type ReplicaObservedLevel = DivergenceLevel | 'behind' | 'unobserved';
export type OrphanAssessment = 'pending' | 'diverging' | 'caught_up' | 'unobserved';
export type DivergenceReason = 'growth' | 'ceiling' | 'not_catching_up' | 'not_applying' | 'not_acking';
export type { ReplicaViewStatus };

export interface DivergenceWindow {
  start: number;
  end: number;
  gapBytes: number;
  bytesPerSec: number | null;
  secondsBehind: number | null;
  replicaGapBytes?: number | null;
  replicaView?: ReplicaViewStatus | null;
}

export interface ReplicaViewReading {
  status: ReplicaViewStatus;
  gapBytes: number | null;
  linkUp: boolean;
  primaryGapBytes: number | null;
}

interface ReplicaWindowAccumulator {
  gaps: number[];
  lastRate: number | null;
}

interface StaleAckAccumulator {
  gapBytes: number;
  samples: number;
}

interface SubsideTracking {
  referenceGap: number;
  windows: number;
}

export interface ReplicaDivergenceState {
  addr: string;
  windows: DivergenceWindow[];
  level: DivergenceLevel;
  eventId: string | null;
  spanStart: number | null;
  baselineRate: number | null;
  subside: SubsideTracking | null;
  belowFloorStreak: number;
  recoveredAt: number | null;
  staleGap: number | null;
  staleWindows: number;
  staleClearWindows: number;
  staleSince: number | null;
  announced: boolean;
  disagreeWindows: number;
  disagreeSince: number | null;
  unconfirmedWindows: number;
  disagreeEventId: string | null;
}

export interface ClosedDivergenceWindow extends DivergenceWindow {
  addr: string;
}

export interface DivergenceConnectionState {
  windowStart: number | null;
  closedWindows: ClosedDivergenceWindow[];
  windowSamples: number;
  lastSampleAt: number | null;
  windowPeakRate: number | null;
  lastRateEwma: number | null;
  lastGapMs: number;
  accumulators: Map<string, ReplicaWindowAccumulator>;
  staleGaps: Map<string, StaleAckAccumulator>;
  rateHistory: number[];
  replid: string | null;
  replicas: Map<string, ReplicaDivergenceState>;
  observed: Set<string>;
  staleAcks: Set<string>;
  closedWindowCount: number;
  lastWindowEnd: number | null;
  windowsHeldSince: number | null;
}

export interface OrphanedDivergence {
  eventIds: Set<string>;
  sinceWindow: number;
  claimed: boolean;
  notified?: boolean;
}

export interface DivergenceFinding {
  kind: 'divergence';
  addr: string;
  level: Exclude<DivergenceLevel, 'none'>;
  reason: DivergenceReason;
  gapBytes: number;
  secondsBehind: number | null;
  bytesPerSec: number | null;
  slopeBytesPerWindow: number;
  windowCount: number;
  spanStart: number;
}

export interface DivergenceRecovery {
  kind: 'recovered' | 'cleared';
  addr: string;
  eventId: string | null;
  gapBytes: number | null;
}

export interface ViewDisagreement {
  kind: 'views_disagree';
  addr: string;
  primaryGapBytes: number;
  replicaGapBytes: number;
  bytesPerSec: number | null;
  windowCount: number;
  spanStart: number;
}

export interface ViewAgreement {
  kind: 'views_agree';
  addr: string;
  eventId: string;
}

export type DivergenceOutcome = DivergenceFinding | DivergenceRecovery | ViewDisagreement | ViewAgreement;

export interface ReplicaDivergenceHistory {
  replica: string;
  level: ReplicaObservedLevel;
  latest: Required<DivergenceWindow> | null;
  windows: Required<DivergenceWindow>[];
}

const LEVEL_RANK: Record<DivergenceLevel, number> = { none: 0, warning: 1, critical: 2 };

export function divergenceWindowMs(pollIntervalMs: number): number {
  return Math.max(DIVERGENCE_MIN_WINDOW_MS, 3 * pollIntervalMs);
}

export function createDivergenceState(): DivergenceConnectionState {
  return {
    windowStart: null,
    closedWindows: [],
    windowSamples: 0,
    lastSampleAt: null,
    windowPeakRate: null,
    lastRateEwma: null,
    lastGapMs: 0,
    accumulators: new Map(),
    staleGaps: new Map(),
    rateHistory: [],
    replid: null,
    replicas: new Map(),
    observed: new Set(),
    staleAcks: new Set(),
    closedWindowCount: 0,
    lastWindowEnd: null,
    windowsHeldSince: null,
  };
}

function writesStopped(window: DivergenceWindow): boolean {
  return window.bytesPerSec === null || window.bytesPerSec === 0;
}

function isBehind(window: Pick<DivergenceWindow, 'gapBytes' | 'secondsBehind'>): boolean {
  if (window.gapBytes < DIVERGENCE_FLOOR_BYTES) return false;
  if (window.secondsBehind === null) return true;
  return window.secondsBehind >= DIVERGENCE_FLOOR_SECONDS;
}

function isStaleAck(line: ReplicationStreamSample['replicas'][number]): boolean {
  return line.lagSec !== null && line.lagSec > DIVERGENCE_STALE_ACK_SEC;
}

function isStreaming(line: ReplicationStreamSample['replicas'][number]): boolean {
  return line.state === 'online' && line.offset > 0;
}

function isTracked(line: ReplicationStreamSample['replicas'][number]): boolean {
  return isStreaming(line) && !isStaleAck(line);
}

function createReplicaState(addr: string): ReplicaDivergenceState {
  return {
    addr,
    windows: [],
    level: 'none',
    eventId: null,
    spanStart: null,
    baselineRate: null,
    subside: null,
    belowFloorStreak: 0,
    recoveredAt: null,
    staleGap: null,
    staleWindows: 0,
    staleClearWindows: 0,
    staleSince: null,
    announced: false,
    disagreeWindows: 0,
    disagreeSince: null,
    unconfirmedWindows: 0,
    disagreeEventId: null,
  };
}

function contiguous(previous: DivergenceWindow, next: DivergenceWindow): boolean {
  return previous.end === next.start;
}

function growthStreak(windows: DivergenceWindow[], recoveredAt: number | null): number {
  let streak = 1;
  for (let i = windows.length - 1; i > 0; i--) {
    const previous = windows[i - 1];
    const sinceRecovery = recoveredAt === null || previous.start >= recoveredAt;
    if (sinceRecovery && contiguous(previous, windows[i]) && windows[i].gapBytes > previous.gapBytes) streak++;
    else break;
  }
  return streak;
}

function gapClosing(gapBytes: number, previousGap: number | null): boolean {
  if (gapBytes < DIVERGENCE_FLOOR_BYTES) return true;
  return previousGap !== null && gapBytes <= previousGap;
}

function behindRun(windows: DivergenceWindow[]): number {
  let run = 0;
  for (let i = windows.length - 1; i >= 0 && isBehind(windows[i]); i--) run++;
  return run;
}

function drainsWithinHorizon(recent: DivergenceWindow[]): boolean {
  const last = recent[recent.length - 1].gapBytes;
  const drainedPerWindow = (recent[0].gapBytes - last) / (recent.length - 1);
  return drainedPerWindow > 0 && last / drainedPerWindow <= DIVERGENCE_RECOVERY_HORIZON_WINDOWS;
}

function ceilingLevel(windows: DivergenceWindow[]): DivergenceLevel {
  const recent = windows.slice(-DIVERGENCE_CEILING_WINDOWS);
  if (recent.length < DIVERGENCE_CEILING_WINDOWS) return 'none';
  if (recent.some((w, i) => i > 0 && !contiguous(recent[i - 1], w))) return 'none';
  if (drainsWithinHorizon(recent)) return 'none';
  const seconds = recent.map((w) => w.secondsBehind);
  if (seconds.some((s) => s === null)) return 'none';
  const lowest = Math.min(...(seconds as number[]));
  if (lowest >= DIVERGENCE_CRIT_SECONDS) return 'critical';
  if (lowest >= DIVERGENCE_WARN_SECONDS) return 'warning';
  return 'none';
}

function baselineRate(rateHistory: number[], excludeLast: number): number | null {
  const prior = rateHistory.slice(0, Math.max(0, rateHistory.length - excludeLast));
  const recent = prior.slice(-DIVERGENCE_BASELINE_WINDOWS);
  return recent.length > 0 ? median(recent) : null;
}

function rateSubsided(replica: ReplicaDivergenceState, last: DivergenceWindow): boolean {
  if (writesStopped(last)) return true;
  if (replica.baselineRate === null) return false;
  return (last.bytesPerSec as number) <= DIVERGENCE_SUBSIDED_RATE_FACTOR * replica.baselineRate;
}

function windowsToDrain(subside: SubsideTracking, gapBytes: number): number {
  const drainedPerWindow = (subside.referenceGap - gapBytes) / subside.windows;
  return drainedPerWindow > 0 ? gapBytes / drainedPerWindow : Infinity;
}

function drainStalled(windows: DivergenceWindow[]): boolean {
  const last = windows[windows.length - 1];
  return last.gapBytes >= windows[windows.length - 1 - DIVERGENCE_RECOVERY_GRACE_WINDOWS].gapBytes;
}

function evaluateReplica(
  replica: ReplicaDivergenceState,
  rateHistory: number[],
): DivergenceOutcome | null {
  const windows = replica.windows;
  const last = windows[windows.length - 1];
  if (windows.length > 1 && !contiguous(windows[windows.length - 2], last)) {
    replica.subside = null;
    replica.belowFloorStreak = 0;
  }

  if (!isBehind(last)) {
    replica.subside = null;
    if (replica.level === 'none') return null;
    const previous = windows[windows.length - 2];
    if (!gapClosing(last.gapBytes, previous && contiguous(previous, last) ? previous.gapBytes : null)) {
      replica.belowFloorStreak = 0;
      return null;
    }
    replica.belowFloorStreak++;
    if (replica.belowFloorStreak < DIVERGENCE_RECOVERED_WINDOWS) return null;
    return { kind: 'recovered', addr: replica.addr, eventId: replica.eventId, gapBytes: last.gapBytes };
  }
  replica.belowFloorStreak = 0;

  const streak = growthStreak(windows, replica.recoveredAt);
  let target: DivergenceLevel = 'none';
  let reason: DivergenceReason = 'growth';

  if (streak >= DIVERGENCE_GROWTH_WINDOWS) target = 'warning';

  const ceiling = ceilingLevel(windows);
  if (LEVEL_RANK[ceiling] > LEVEL_RANK[target]) {
    target = ceiling;
    reason = 'ceiling';
  }

  if (replica.baselineRate === null && (replica.level !== 'none' || target !== 'none')) {
    replica.baselineRate = baselineRate(rateHistory, Math.max(streak, behindRun(windows)));
  }

  const stopped = writesStopped(last);
  const alerting = replica.level !== 'none' || target !== 'none';
  if ((alerting || stopped) && rateSubsided(replica, last)) {
    if (replica.subside === null) {
      replica.subside = { referenceGap: last.gapBytes, windows: 0 };
    } else if (last.gapBytes <= DIVERGENCE_RECOVERY_SHRINK_FRACTION * replica.subside.referenceGap) {
      replica.subside = { referenceGap: last.gapBytes, windows: 0 };
    } else {
      replica.subside.windows++;
      if (replica.subside.windows >= DIVERGENCE_RECOVERY_GRACE_WINDOWS) {
        if (stopped && drainStalled(windows)) {
          target = 'critical';
          reason = 'not_applying';
        } else if (
          !stopped &&
          windowsToDrain(replica.subside, last.gapBytes) > DIVERGENCE_RECOVERY_HORIZON_WINDOWS
        ) {
          target = 'critical';
          reason = 'not_catching_up';
        }
      }
    }
  } else {
    replica.subside = null;
  }

  if (LEVEL_RANK[target] <= LEVEL_RANK[replica.level]) return null;

  const counted = Math.min(Math.max(streak, DIVERGENCE_CEILING_WINDOWS), windows.length);
  const first = windows[windows.length - counted];
  const spanStart = replica.spanStart ?? first.start;
  return {
    kind: 'divergence',
    addr: replica.addr,
    level: target as Exclude<DivergenceLevel, 'none'>,
    reason,
    gapBytes: last.gapBytes,
    secondsBehind: last.secondsBehind,
    bytesPerSec: last.bytesPerSec,
    slopeBytesPerWindow: counted > 1 ? (last.gapBytes - first.gapBytes) / (counted - 1) : 0,
    windowCount: counted,
    spanStart,
  };
}

function staleAckFinding(
  replica: ReplicaDivergenceState,
  gapBytes: number,
  start: number,
  rate: number | null,
): DivergenceOutcome | null {
  const secondsBehind = rate === null || rate === 0 ? null : gapBytes / rate;
  const previousGap = replica.staleGap;
  replica.staleGap = gapBytes;
  if (!isBehind({ gapBytes, secondsBehind })) {
    replica.staleWindows = 0;
    replica.staleSince = null;
    if (replica.level === 'none') return null;
    if (!gapClosing(gapBytes, previousGap)) {
      replica.staleClearWindows = 0;
      return null;
    }
    replica.staleClearWindows++;
    if (replica.staleClearWindows < DIVERGENCE_RECOVERED_WINDOWS) return null;
    return { kind: 'recovered', addr: replica.addr, eventId: replica.eventId, gapBytes };
  }
  replica.staleClearWindows = 0;
  if (replica.staleWindows === 0) replica.staleSince = start;
  replica.staleWindows++;
  const target: DivergenceLevel =
    replica.staleWindows >= DIVERGENCE_STALE_CRIT_WINDOWS
      ? 'critical'
      : replica.staleWindows >= DIVERGENCE_STALE_WARN_WINDOWS
        ? 'warning'
        : 'none';
  if (LEVEL_RANK[target] <= LEVEL_RANK[replica.level]) return null;
  return {
    kind: 'divergence',
    addr: replica.addr,
    level: target as Exclude<DivergenceLevel, 'none'>,
    reason: 'not_acking',
    gapBytes,
    secondsBehind,
    bytesPerSec: rate,
    slopeBytesPerWindow: 0,
    windowCount: replica.staleWindows,
    spanStart: replica.spanStart ?? (replica.staleSince as number),
  };
}

function clearStaleStreak(replica: ReplicaDivergenceState): void {
  replica.staleGap = null;
  replica.staleWindows = 0;
  replica.staleClearWindows = 0;
  replica.staleSince = null;
}

function clearDisagreementStreak(replica: ReplicaDivergenceState): void {
  replica.disagreeWindows = 0;
  replica.disagreeSince = null;
  replica.unconfirmedWindows = 0;
}

function dropReplica(
  state: DivergenceConnectionState,
  replica: ReplicaDivergenceState,
  at: number,
): DivergenceOutcome[] {
  if (replica.windows.length > 0) state.windowsHeldSince = at;
  const outcomes: DivergenceOutcome[] = replica.disagreeEventId
    ? [{ kind: 'views_agree', addr: replica.addr, eventId: replica.disagreeEventId }]
    : [];
  clearDisagreementStreak(replica);
  if (replica.level === 'none') {
    state.replicas.delete(replica.addr);
    return outcomes;
  }
  replica.windows = [];
  replica.subside = null;
  replica.belowFloorStreak = 0;
  clearStaleStreak(replica);
  return [...outcomes, { kind: 'cleared', addr: replica.addr, eventId: replica.eventId, gapBytes: null }];
}

function hasGapReading(state: DivergenceConnectionState, addr: string): boolean {
  const gaps = state.accumulators.get(addr)?.gaps.length ?? 0;
  return gaps >= DIVERGENCE_MIN_SAMPLES || gaps * 2 >= state.windowSamples;
}

function staleWindowGap(state: DivergenceConnectionState, addr: string): number | null {
  const stale = state.staleGaps.get(addr);
  if (stale === undefined || hasGapReading(state, addr)) return null;
  return stale.samples * 2 > state.windowSamples ? stale.gapBytes : null;
}

function closeWindow(
  state: DivergenceConnectionState,
  start: number,
  end: number,
  rate: number | null,
): DivergenceOutcome[] {
  const outcomes: DivergenceOutcome[] = [];
  state.closedWindowCount++;
  state.lastWindowEnd = end;
  state.windowsHeldSince ??= start;
  if (rate !== null) {
    state.rateHistory.push(rate);
    if (state.rateHistory.length > DIVERGENCE_HISTORY_WINDOWS) state.rateHistory.shift();
  }

  for (const [addr, replica] of state.replicas) {
    if (state.accumulators.has(addr) || state.staleGaps.has(addr)) continue;
    outcomes.push(...dropReplica(state, replica, end));
  }

  for (const addr of state.staleGaps.keys()) {
    const gapBytes = staleWindowGap(state, addr);
    if (gapBytes === null) continue;
    const replica = state.replicas.get(addr) ?? createReplicaState(addr);
    state.replicas.set(addr, replica);
    const finding = staleAckFinding(replica, gapBytes, start, rate);
    if (finding) outcomes.push(finding);
  }

  for (const replica of state.replicas.values()) {
    if (staleWindowGap(state, replica.addr) === null) clearStaleStreak(replica);
  }

  for (const [addr, acc] of state.accumulators) {
    if (!hasGapReading(state, addr)) continue;
    const replica = state.replicas.get(addr) ?? createReplicaState(addr);
    state.replicas.set(addr, replica);
    const gapBytes = median(acc.gaps);
    const bytesPerSec = rate === 0 ? 0 : acc.lastRate;
    const secondsBehind = bytesPerSec === null || bytesPerSec === 0 ? null : gapBytes / bytesPerSec;
    const window: DivergenceWindow = { start, end, gapBytes, bytesPerSec, secondsBehind };
    replica.windows.push(window);
    state.closedWindows.push({ addr, ...window });
    if (replica.windows.length > DIVERGENCE_HISTORY_WINDOWS) {
      const evicted = replica.windows.shift() as DivergenceWindow;
      state.windowsHeldSince = Math.max(state.windowsHeldSince ?? 0, evicted.end);
    }
    const outcome = evaluateReplica(replica, state.rateHistory);
    if (outcome) outcomes.push(outcome);
  }

  state.accumulators = new Map();
  state.staleGaps = new Map();
  return outcomes;
}

function resetRateBaseline(state: DivergenceConnectionState): void {
  state.rateHistory = [];
  for (const replica of state.replicas.values()) replica.baselineRate = null;
}

function windowRate(state: DivergenceConnectionState, rateEwma: number | null): number | null {
  const idle = state.windowPeakRate !== null && state.windowPeakRate < DIVERGENCE_IDLE_BYTES_PER_SEC;
  return idle ? 0 : rateEwma;
}

export function observeDivergence(
  state: DivergenceConnectionState,
  sample: ReplicationStreamSample,
  windowMs: number,
): DivergenceOutcome[] {
  if (sample.role !== 'primary') {
    state.windowStart = null;
    state.windowSamples = 0;
    state.lastSampleAt = null;
    state.lastGapMs = 0;
    state.windowPeakRate = null;
    state.lastRateEwma = null;
    state.accumulators = new Map();
    state.staleGaps = new Map();
    state.observed = new Set();
    state.staleAcks = new Set();
    state.replid = null;
    resetRateBaseline(state);
    return [...state.replicas.values()].flatMap((replica) => dropReplica(state, replica, sample.timestamp));
  }
  const outcomes: DivergenceOutcome[] = [];

  if (state.replid !== sample.replid) {
    if (state.replid !== null) resetRateBaseline(state);
    state.replid = sample.replid;
  }

  const previousSampleAt = state.lastSampleAt ?? sample.timestamp;
  const gapMs = sample.timestamp - previousSampleAt;
  const outage = gapMs > Math.max(windowMs, state.lastGapMs * DIVERGENCE_OUTAGE_GAP_FACTOR);
  const windowEnd = outage ? previousSampleAt : sample.timestamp;
  state.lastSampleAt = sample.timestamp;
  state.lastGapMs = gapMs;
  if (!outage && sample.bytesPerSec !== null) {
    state.windowPeakRate = Math.max(state.windowPeakRate ?? 0, sample.bytesPerSec);
  }

  if (
    state.windowStart !== null &&
    windowEnd - state.windowStart >= windowMs &&
    state.windowSamples >= DIVERGENCE_MIN_SAMPLES
  ) {
    const sealingRate = outage ? state.lastRateEwma : sample.bytesPerSecEwma;
    outcomes.push(...closeWindow(state, state.windowStart, windowEnd, windowRate(state, sealingRate)));
    state.windowStart = null;
  }
  state.lastRateEwma = sample.bytesPerSecEwma;
  if (outage) {
    state.windowStart = null;
    for (const replica of state.replicas.values()) clearStaleStreak(replica);
  }
  if (state.windowStart === null) {
    state.windowStart = sample.timestamp;
    state.windowSamples = 0;
    state.windowPeakRate = null;
    state.accumulators = new Map();
    state.staleGaps = new Map();
  }
  state.windowSamples++;

  const streaming = sample.replicas.filter(isStreaming);
  state.observed = new Set(streaming.map((line) => line.addr));
  state.staleAcks = new Set(streaming.filter(isStaleAck).map((line) => line.addr));
  for (const line of sample.replicas) {
    if (isStreaming(line) && isStaleAck(line)) {
      const samples = (state.staleGaps.get(line.addr)?.samples ?? 0) + 1;
      state.staleGaps.set(line.addr, { gapBytes: line.gapBytes, samples });
    }
    if (!isTracked(line)) continue;
    const acc = state.accumulators.get(line.addr) ?? { gaps: [], lastRate: null };
    acc.gaps.push(line.gapBytes);
    acc.lastRate = sample.bytesPerSecEwma;
    state.accumulators.set(line.addr, acc);
  }

  return outcomes;
}

export function withReplicaView(window: DivergenceWindow): Required<DivergenceWindow> {
  return { ...window, replicaGapBytes: window.replicaGapBytes ?? null, replicaView: window.replicaView ?? null };
}

export function divergenceWindowsHeld(
  state: DivergenceConnectionState | undefined,
  startTime: number,
): boolean {
  const heldSince = state?.windowsHeldSince ?? null;
  return heldSince !== null && startTime > heldSince;
}

export function staleAckWindow(
  state: DivergenceConnectionState | undefined,
  addr: string,
): DivergenceWindow | null {
  const stale = state?.staleGaps.get(addr);
  if (stale === undefined || !state?.staleAcks.has(addr) || state.lastSampleAt === null) return null;
  const at = state.lastSampleAt;
  return { start: at, end: at, gapBytes: stale.gapBytes, bytesPerSec: null, secondsBehind: null };
}

export function replicaObservedLevel(
  state: DivergenceConnectionState | undefined,
  addr: string,
  now: number,
  staleAfterMs: number,
  storedWindow?: DivergenceWindow,
): ReplicaObservedLevel {
  const replica = state?.replicas.get(addr);
  const level = replica ? replica.level : 'none';
  if (level !== 'none') return level;
  if (!state?.observed.has(addr) || state.lastSampleAt === null) return 'unobserved';
  if (now - state.lastSampleAt > staleAfterMs) return 'unobserved';
  const last =
    staleAckWindow(state, addr) ?? replica?.windows[replica.windows.length - 1] ?? storedWindow;
  return last && isBehind(last) ? 'behind' : 'none';
}

export function assessOrphanedReplica(
  state: DivergenceConnectionState,
  addr: string,
  sinceWindow: number,
): OrphanAssessment {
  const replica = state.replicas.get(addr);
  if (replica && replica.level !== 'none') return 'diverging';
  if (!state.observed.has(addr)) {
    const notPrimary = state.windowStart === null;
    const absent = state.closedWindowCount - sinceWindow >= DIVERGENCE_RECOVERED_WINDOWS;
    return notPrimary || absent ? 'unobserved' : 'pending';
  }
  const recent = (replica?.windows ?? []).slice(-DIVERGENCE_RECOVERED_WINDOWS);
  if (recent.length < DIVERGENCE_RECOVERED_WINDOWS) return 'pending';
  if (recent[recent.length - 1].end !== state.lastWindowEnd) return 'pending';
  const steady = recent.every((window, i) => i === 0 || contiguous(recent[i - 1], window));
  return steady && !recent.some(isBehind) ? 'caught_up' : 'pending';
}

export function drainClosedWindows(state: DivergenceConnectionState): ClosedDivergenceWindow[] {
  const drained = state.closedWindows;
  state.closedWindows = [];
  return drained;
}

export function requeueClosedWindows(
  state: DivergenceConnectionState,
  windows: ClosedDivergenceWindow[],
): void {
  state.closedWindows = [...windows, ...state.closedWindows].slice(-DIVERGENCE_PERSIST_BACKLOG);
}

export function acknowledgeDivergence(
  state: DivergenceConnectionState,
  finding: DivergenceFinding,
  eventId: string,
): void {
  const replica = state.replicas.get(finding.addr);
  if (!replica) return;
  replica.level = finding.level;
  replica.eventId = eventId;
  replica.spanStart = finding.spanStart;
}

export function acknowledgeRecovery(state: DivergenceConnectionState, addr: string): void {
  const replica = state.replicas.get(addr);
  if (!replica) return;
  replica.level = 'none';
  replica.eventId = null;
  replica.spanStart = null;
  replica.baselineRate = null;
  replica.subside = null;
  replica.belowFloorStreak = 0;
  replica.recoveredAt = replica.windows[replica.windows.length - 1]?.end ?? null;
  replica.announced = false;
  clearStaleStreak(replica);
}

export function markDivergenceAnnounced(state: DivergenceConnectionState, addr: string): void {
  const replica = state.replicas.get(addr);
  if (replica) replica.announced = true;
}

function viewsDisagree(reading: ReplicaViewReading, bytesPerSec: number | null): boolean | null {
  if (reading.status !== 'ok' || reading.gapBytes === null || reading.primaryGapBytes === null) return null;
  const difference = Math.abs(reading.primaryGapBytes - reading.gapBytes);
  if (difference < DIVERGENCE_FLOOR_BYTES) return false;
  return bytesPerSec === null || bytesPerSec === 0 || difference / bytesPerSec >= DIVERGENCE_FLOOR_SECONDS;
}

function replicaViewBehind(reading: ReplicaViewReading, bytesPerSec: number | null): boolean {
  if (reading.status !== 'ok' || reading.gapBytes === null) return false;
  if (!reading.linkUp) return true;
  const secondsBehind = bytesPerSec === null || bytesPerSec === 0 ? null : reading.gapBytes / bytesPerSec;
  return isBehind({ gapBytes: reading.gapBytes, secondsBehind });
}

function tagClosedWindow(state: DivergenceConnectionState, addr: string, window: DivergenceWindow): void {
  for (let i = state.closedWindows.length - 1; i >= 0; i--) {
    const closed = state.closedWindows[i];
    if (closed.addr !== addr || closed.end !== window.end) continue;
    closed.replicaGapBytes = window.replicaGapBytes;
    closed.replicaView = window.replicaView;
    return;
  }
}

function trackDisagreement(
  replica: ReplicaDivergenceState,
  window: DivergenceWindow | null,
  reading: ReplicaViewReading | undefined,
): DivergenceOutcome | null {
  if (window && reading && viewsDisagree(reading, window.bytesPerSec) === true) {
    const previous = replica.windows[replica.windows.length - 2];
    if (!previous || !contiguous(previous, window)) replica.disagreeWindows = 0;
    if (replica.disagreeWindows === 0) replica.disagreeSince = window.start;
    replica.disagreeWindows++;
    replica.unconfirmedWindows = 0;
    if (replica.disagreeEventId !== null || replica.disagreeWindows < DIVERGENCE_DISAGREE_WINDOWS) return null;
    return {
      kind: 'views_disagree',
      addr: replica.addr,
      primaryGapBytes: reading.primaryGapBytes as number,
      replicaGapBytes: reading.gapBytes as number,
      bytesPerSec: window.bytesPerSec,
      windowCount: replica.disagreeWindows,
      spanStart: replica.disagreeSince as number,
    };
  }
  replica.disagreeWindows = 0;
  replica.disagreeSince = null;
  if (replica.disagreeEventId === null) return null;
  replica.unconfirmedWindows++;
  if (replica.unconfirmedWindows < DIVERGENCE_RECOVERED_WINDOWS) return null;
  return { kind: 'views_agree', addr: replica.addr, eventId: replica.disagreeEventId };
}

export function applyReplicaViews(
  state: DivergenceConnectionState,
  outcomes: DivergenceOutcome[],
  readings: ReadonlyMap<string, ReplicaViewReading>,
): DivergenceOutcome[] {
  const end = state.lastWindowEnd;
  const currentWindow = (replica: ReplicaDivergenceState | undefined) => {
    const last = replica?.windows[replica.windows.length - 1];
    return last !== undefined && last.end === end ? last : null;
  };
  const applied = outcomes.filter((outcome) => {
    if (outcome.kind !== 'recovered') return true;
    const reading = readings.get(outcome.addr);
    const rate = currentWindow(state.replicas.get(outcome.addr))?.bytesPerSec ?? state.rateHistory.at(-1) ?? null;
    return !reading || !replicaViewBehind(reading, rate);
  });
  for (const replica of state.replicas.values()) {
    const window = currentWindow(replica);
    const reading = readings.get(replica.addr);
    if (window && reading) {
      window.replicaGapBytes = reading.gapBytes;
      window.replicaView = reading.status;
      tagClosedWindow(state, replica.addr, window);
    }
    const outcome = trackDisagreement(replica, window, reading);
    if (outcome) applied.push(outcome);
  }
  return applied;
}

export function replicasToSample(state: DivergenceConnectionState, outcomes: DivergenceOutcome[]): string[] {
  const end = state.lastWindowEnd;
  const windowed = [...state.replicas.values()]
    .filter((replica) => replica.windows[replica.windows.length - 1]?.end === end)
    .map((replica) => replica.addr);
  const alerting = outcomes
    .filter((outcome) => outcome.kind === 'divergence' || outcome.kind === 'recovered')
    .map((outcome) => outcome.addr);
  return [...new Set([...windowed, ...alerting])];
}

export function replicaEventIds(replica: ReplicaDivergenceState): string[] {
  return [replica.eventId, replica.disagreeEventId].filter((id): id is string => id !== null);
}

export function acknowledgeViewDisagreement(
  state: DivergenceConnectionState,
  addr: string,
  eventId: string,
): void {
  const replica = state.replicas.get(addr);
  if (!replica) return;
  replica.disagreeEventId = eventId;
  replica.unconfirmedWindows = 0;
}

export function acknowledgeViewAgreement(
  state: DivergenceConnectionState,
  addr: string,
  eventId: string,
): void {
  const replica = state.replicas.get(addr);
  if (!replica || replica.disagreeEventId !== eventId) return;
  replica.disagreeEventId = null;
  clearDisagreementStreak(replica);
}

export function describeViewDisagreement(outcome: ViewDisagreement): string {
  const cause =
    outcome.primaryGapBytes > outcome.replicaGapBytes
      ? 'the replica is further along than it has acknowledged, so its acknowledgements are late or lost on the way to the primary'
      : 'the replica reports less than it has acknowledged, so the primary is tracking an offset the replica no longer has';
  return (
    `WARNING: Replica ${outcome.addr} and its primary disagree on how far behind it is: ` +
    `the primary sees ${formatBytes(outcome.primaryGapBytes)}, the replica reports ` +
    `${formatBytes(outcome.replicaGapBytes)}, for ${outcome.windowCount} windows in a row; ${cause}.`
  );
}

export const DIVERGENCE_COMPOUND_SIGNALS: ReadonlyMap<MetricType, string> = new Map([
  [MetricType.MEMORY_USED, 'memory growth'],
  [MetricType.MEMORY_OVERHEAD, 'memory overhead'],
  [MetricType.REPL_BUFFER_PRESSURE, 'replica output-buffer pressure'],
  [MetricType.FORK_MEMORY_RISK, 'fork copy-on-write pressure'],
  [MetricType.INPUT_KBPS, 'write-rate spike'],
  [MetricType.OPS_PER_SEC, 'write-rate spike'],
  [MetricType.CLUSTER_TOPOLOGY, 'cluster topology disagreement'],
  [MetricType.CPU_UTILIZATION, 'CPU saturation'],
]);

function describeReason(finding: DivergenceFinding): string {
  switch (finding.reason) {
    case 'growth':
      return (
        `the gap grew across ${finding.windowCount} consecutive windows ` +
        `(+${formatBytes(finding.slopeBytesPerWindow)} per window)`
      );
    case 'ceiling':
      return `it has stayed at least ${
        finding.level === 'critical' ? DIVERGENCE_CRIT_SECONDS : DIVERGENCE_WARN_SECONDS
      }s behind for ${DIVERGENCE_CEILING_WINDOWS} windows`;
    case 'not_catching_up':
      return 'the write rate is back to baseline but the gap has not closed';
    case 'not_applying':
      return 'writes have stopped but the replica is not applying the backlog';
    case 'not_acking':
      return `the replica has not acknowledged the stream for over ${DIVERGENCE_STALE_ACK_SEC}s`;
  }
}

export function describeDivergence(finding: DivergenceFinding): string {
  const behind =
    finding.secondsBehind === null
      ? formatBytes(finding.gapBytes)
      : `${formatBytes(finding.gapBytes)} (~${Math.round(finding.secondsBehind)}s at the current write rate)`;
  return (
    `${finding.level === 'critical' ? 'CRITICAL' : 'WARNING'}: Replica ${finding.addr} is ` +
    `${behind} behind the primary; ${describeReason(finding)}.`
  );
}
