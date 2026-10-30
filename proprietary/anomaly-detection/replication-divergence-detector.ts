import { ReplicationStreamSample } from './replication-stream';
import { MetricType } from './types';

export const DIVERGENCE_MIN_WINDOW_MS = 30_000;
export const DIVERGENCE_MIN_SAMPLES = 3;
const DIVERGENCE_OUTAGE_GAP_FACTOR = 2;
export const DIVERGENCE_GROWTH_WINDOWS = 4;
export const DIVERGENCE_FLOOR_BYTES = 1024 * 1024;
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
export const DIVERGENCE_STALE_WARN_WINDOWS = 2;
export const DIVERGENCE_STALE_CRIT_WINDOWS = 4;

export type DivergenceLevel = 'none' | 'warning' | 'critical';
export type DivergenceReason = 'growth' | 'ceiling' | 'not_catching_up' | 'not_applying' | 'not_acking';

export interface DivergenceWindow {
  start: number;
  end: number;
  gapBytes: number;
  bytesPerSec: number | null;
  secondsBehind: number | null;
}

interface ReplicaWindowAccumulator {
  gaps: number[];
  lastRate: number | null;
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
  staleWindows: number;
  staleSince: number | null;
  clearing: boolean;
}

export interface DivergenceConnectionState {
  windowStart: number | null;
  windowSamples: number;
  lastSampleAt: number | null;
  lastGapMs: number;
  accumulators: Map<string, ReplicaWindowAccumulator>;
  staleGaps: Map<string, number>;
  rateHistory: number[];
  replicas: Map<string, ReplicaDivergenceState>;
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

export type DivergenceOutcome = DivergenceFinding | DivergenceRecovery;

const LEVEL_RANK: Record<DivergenceLevel, number> = { none: 0, warning: 1, critical: 2 };

export function divergenceWindowMs(pollIntervalMs: number): number {
  return Math.max(DIVERGENCE_MIN_WINDOW_MS, 3 * pollIntervalMs);
}

export function createDivergenceState(): DivergenceConnectionState {
  return {
    windowStart: null,
    windowSamples: 0,
    lastSampleAt: null,
    lastGapMs: 0,
    accumulators: new Map(),
    staleGaps: new Map(),
    rateHistory: [],
    replicas: new Map(),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function writesStopped(window: DivergenceWindow): boolean {
  return window.bytesPerSec === null || window.bytesPerSec === 0;
}

function isBehind(window: DivergenceWindow): boolean {
  if (window.gapBytes < DIVERGENCE_FLOOR_BYTES) return false;
  if (window.secondsBehind === null) return true;
  return window.secondsBehind >= DIVERGENCE_FLOOR_SECONDS;
}

function isStaleAck(line: ReplicationStreamSample['replicas'][number]): boolean {
  return line.lagSec !== null && line.lagSec > DIVERGENCE_STALE_ACK_SEC;
}

function isTracked(line: ReplicationStreamSample['replicas'][number]): boolean {
  return line.state === 'online' && !isStaleAck(line);
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
    staleWindows: 0,
    staleSince: null,
    clearing: false,
  };
}

function contiguous(previous: DivergenceWindow, next: DivergenceWindow): boolean {
  return previous.end === next.start;
}

function growthStreak(windows: DivergenceWindow[]): number {
  let streak = 1;
  for (let i = windows.length - 1; i > 0; i--) {
    if (contiguous(windows[i - 1], windows[i]) && windows[i].gapBytes > windows[i - 1].gapBytes) streak++;
    else break;
  }
  return streak;
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
    replica.belowFloorStreak++;
    if (replica.belowFloorStreak < DIVERGENCE_RECOVERED_WINDOWS) return null;
    return { kind: 'recovered', addr: replica.addr, eventId: replica.eventId, gapBytes: last.gapBytes };
  }
  replica.belowFloorStreak = 0;

  const streak = growthStreak(windows);
  let target: DivergenceLevel = 'none';
  let reason: DivergenceReason = 'growth';

  if (streak >= DIVERGENCE_GROWTH_WINDOWS) target = 'warning';

  const ceiling = ceilingLevel(windows);
  if (LEVEL_RANK[ceiling] > LEVEL_RANK[target]) {
    target = ceiling;
    reason = 'ceiling';
  }

  if (replica.level === 'none' && target !== 'none') {
    replica.baselineRate = baselineRate(rateHistory, streak);
  }

  const stopped = writesStopped(last);
  if ((replica.level !== 'none' || target !== 'none' || stopped) && rateSubsided(replica, last)) {
    if (replica.subside === null) {
      replica.subside = { referenceGap: last.gapBytes, windows: 0 };
    } else if (last.gapBytes <= DIVERGENCE_RECOVERY_SHRINK_FRACTION * replica.subside.referenceGap) {
      replica.subside = { referenceGap: last.gapBytes, windows: 0 };
    } else {
      replica.subside.windows++;
      if (
        replica.subside.windows >= DIVERGENCE_RECOVERY_GRACE_WINDOWS &&
        windowsToDrain(replica.subside, last.gapBytes) > DIVERGENCE_RECOVERY_HORIZON_WINDOWS
      ) {
        target = 'critical';
        reason = stopped ? 'not_applying' : 'not_catching_up';
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
): DivergenceFinding | null {
  if (rate === null || rate === 0) return null;
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
    secondsBehind: gapBytes / rate,
    bytesPerSec: rate,
    slopeBytesPerWindow: 0,
    windowCount: replica.staleWindows,
    spanStart: replica.spanStart ?? (replica.staleSince as number),
  };
}

function dropReplica(
  state: DivergenceConnectionState,
  replica: ReplicaDivergenceState,
): DivergenceRecovery[] {
  if (replica.level === 'none') {
    state.replicas.delete(replica.addr);
    return [];
  }
  replica.windows = [];
  replica.subside = null;
  replica.belowFloorStreak = 0;
  replica.staleWindows = 0;
  replica.staleSince = null;
  replica.clearing = true;
  return [{ kind: 'cleared', addr: replica.addr, eventId: replica.eventId, gapBytes: null }];
}

function closeWindow(
  state: DivergenceConnectionState,
  start: number,
  end: number,
  rate: number | null,
): DivergenceOutcome[] {
  const outcomes: DivergenceOutcome[] = [];
  if (rate !== null) {
    state.rateHistory.push(rate);
    if (state.rateHistory.length > DIVERGENCE_HISTORY_WINDOWS) state.rateHistory.shift();
  }

  for (const [addr, replica] of state.replicas) {
    if (!replica.clearing && (state.accumulators.has(addr) || state.staleGaps.has(addr))) continue;
    outcomes.push(...dropReplica(state, replica));
  }

  for (const [addr, gapBytes] of state.staleGaps) {
    if (state.accumulators.has(addr)) continue;
    const replica = state.replicas.get(addr) ?? createReplicaState(addr);
    state.replicas.set(addr, replica);
    if (replica.clearing) continue;
    const finding = staleAckFinding(replica, gapBytes, start, rate);
    if (finding) outcomes.push(finding);
  }

  for (const [addr, acc] of state.accumulators) {
    if (acc.gaps.length < DIVERGENCE_MIN_SAMPLES) continue;
    const replica = state.replicas.get(addr) ?? createReplicaState(addr);
    state.replicas.set(addr, replica);
    replica.staleWindows = 0;
    replica.staleSince = null;
    const gapBytes = median(acc.gaps);
    const secondsBehind = acc.lastRate === null || acc.lastRate === 0 ? null : gapBytes / acc.lastRate;
    replica.windows.push({ start, end, gapBytes, bytesPerSec: acc.lastRate, secondsBehind });
    if (replica.windows.length > DIVERGENCE_HISTORY_WINDOWS) replica.windows.shift();
    if (replica.clearing) continue;
    const outcome = evaluateReplica(replica, state.rateHistory);
    if (outcome) outcomes.push(outcome);
  }

  state.accumulators = new Map();
  state.staleGaps = new Map();
  return outcomes;
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
    state.accumulators = new Map();
    state.staleGaps = new Map();
    return [...state.replicas.values()].flatMap((replica) => dropReplica(state, replica));
  }
  const outcomes: DivergenceOutcome[] = [];

  const previousSampleAt = state.lastSampleAt ?? sample.timestamp;
  const gapMs = sample.timestamp - previousSampleAt;
  const outage = gapMs > Math.max(windowMs, state.lastGapMs * DIVERGENCE_OUTAGE_GAP_FACTOR);
  const windowEnd = outage ? previousSampleAt : sample.timestamp;
  state.lastSampleAt = sample.timestamp;
  state.lastGapMs = gapMs;

  if (
    state.windowStart !== null &&
    windowEnd - state.windowStart >= windowMs &&
    state.windowSamples >= DIVERGENCE_MIN_SAMPLES
  ) {
    outcomes.push(...closeWindow(state, state.windowStart, windowEnd, sample.bytesPerSecEwma));
    state.windowStart = null;
  }
  if (outage) {
    state.windowStart = null;
    for (const replica of state.replicas.values()) {
      replica.staleWindows = 0;
      replica.staleSince = null;
    }
  }
  if (state.windowStart === null) {
    state.windowStart = sample.timestamp;
    state.windowSamples = 0;
    state.accumulators = new Map();
    state.staleGaps = new Map();
  }
  state.windowSamples++;

  for (const line of sample.replicas) {
    if (line.state === 'online' && isStaleAck(line)) state.staleGaps.set(line.addr, line.gapBytes);
    if (!isTracked(line)) continue;
    const acc = state.accumulators.get(line.addr) ?? { gaps: [], lastRate: null };
    acc.gaps.push(line.gapBytes);
    acc.lastRate = sample.bytesPerSecEwma;
    state.accumulators.set(line.addr, acc);
  }

  return outcomes;
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
  replica.staleWindows = 0;
  replica.staleSince = null;
  replica.clearing = false;
}

export const DIVERGENCE_CORRELATED_METRICS: ReadonlySet<MetricType> = new Set([
  MetricType.MEMORY_USED,
  MetricType.MEMORY_OVERHEAD,
  MetricType.REPL_BUFFER_PRESSURE,
  MetricType.FORK_MEMORY_RISK,
  MetricType.INPUT_KBPS,
  MetricType.OPS_PER_SEC,
  MetricType.CLUSTER_TOPOLOGY,
]);

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

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
