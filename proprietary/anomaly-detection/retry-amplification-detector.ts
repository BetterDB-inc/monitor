import { MetricType } from './types';

export const RETRY_AMP_WINDOW_MS = 60_000;
export const RETRY_AMP_MIN_COVERAGE = 0.5;
export const RETRY_AMP_MAX_POLL_GAP_MS = 10_000;
export const RETRY_AMP_EVENT_GRACE_MS = 15_000;
export const RETRY_AMP_BASELINE_WINDOWS = 30;
export const RETRY_AMP_ARM_WINDOWS = 10;
export const RETRY_AMP_MIN_WINDOWS = 3;
export const RETRY_AMP_REARM_COLD_WINDOWS = 2;
export const RETRY_AMP_CMDS_PER_CLIENT_RATIO = 1.3;
export const RETRY_AMP_OPS_RATIO = 1.2;
export const RETRY_AMP_CLIENT_TOLERANCE = 0.15;
export const RETRY_AMP_STRESS_RATIO = 3;
export const RETRY_AMP_ERROR_FLOOR_PER_SEC = 1;
export const RETRY_AMP_CHURN_FLOOR_PER_SEC = 1;
export const RETRY_AMP_MIN_CORRELATION = 0.5;
export const RETRY_AMP_STRESS_HOLD_MS = 30 * 60_000;
export const RETRY_AMP_SATURATION_HOLD_MS = 5 * 60_000;
export const RETRY_AMP_POLL_GAP_MULTIPLIER = 3;

export const RETRY_AMP_STRESS_METRICS: readonly MetricType[] = [MetricType.COMMAND_P99];
export const RETRY_AMP_SATURATION_METRICS: readonly MetricType[] = [
  MetricType.LOAD_SATURATION,
  MetricType.CPU_UTILIZATION,
  MetricType.REJECTED_CONNECTIONS,
  MetricType.CLIENT_SATURATION,
  MetricType.CLIENT_LOCKOUT_RISK,
];

export type RetryAmplificationLevel = 'none' | 'warning' | 'critical';
export type RetryAmplificationTrigger = 'latency' | 'errors' | 'churn' | 'saturation';
export type RetryAmplificationEpisodeClass = 'transient' | 'unconfirmed' | 'amplifying';

export interface RetryAmplificationEventRef {
  metricType: MetricType;
  timestamp: number;
}

export interface RetryAmplificationSample {
  timestamp: number;
  opsPerSec: number | null;
  connectedClients: number | null;
  totalCommands: number | null;
  totalErrorReplies: number | null;
  connectsPerSec: number | null;
  recentEvents: RetryAmplificationEventRef[];
  stressActive?: boolean;
  activeSaturation?: MetricType[];
}

export interface RetryAmplificationWindow {
  start: number;
  opsPerSec: number;
  connectedClients: number;
  cmdsPerClient: number;
  errorRate: number | null;
  churnPerSec: number | null;
  latencyEvent: boolean;
  saturationMetrics: MetricType[];
}

export interface WindowBaseline {
  opsPerSec: number;
  connectedClients: number;
  cmdsPerClient: number;
  errorRate: number | null;
  churnPerSec: number | null;
}

interface OpenWindow {
  start: number;
  coveredMs: number;
  opsSum: number;
  opsCount: number;
  clientsSum: number;
  clientsCount: number;
  commands: number;
  commandsMs: number;
  errors: number;
  errorsMs: number;
  churnSum: number;
  churnCount: number;
  latencyEvent: boolean;
  saturationMetrics: Set<MetricType>;
}

interface LastReading {
  timestamp: number;
  totalCommands: number | null;
  totalErrorReplies: number | null;
}

export interface RetryAmplificationEpisode {
  classification: RetryAmplificationEpisodeClass;
  level: RetryAmplificationLevel;
  trigger: RetryAmplificationTrigger | null;
  windows: number;
  startedAt: number;
  endedAt: number;
}

export interface RetryAmplificationFinding {
  level: 'warning' | 'critical';
  trigger: RetryAmplificationTrigger;
  windows: number;
  loadRatio: number;
  correlation: number;
  connectedClients: number;
  relatedMetrics: MetricType[];
  message: string;
  timestamp: number;
}

export interface RetryAmplificationState {
  maxPollGapMs: number;
  last: LastReading | null;
  window: OpenWindow | null;
  closing: OpenWindow | null;
  coldWindows: RetryAmplificationWindow[];
  hotRun: RetryAmplificationWindow[];
  coldStreak: number;
  episodeLevel: RetryAmplificationLevel;
  ackedLevel: RetryAmplificationLevel;
  pending: RetryAmplificationFinding | null;
  lastEpisode: RetryAmplificationEpisode | null;
}

const LEVEL_RANK: Record<RetryAmplificationLevel, number> = { none: 0, warning: 1, critical: 2 };

const TRIGGER_LABEL: Record<RetryAmplificationTrigger, string> = {
  latency: 'a latency regression (COMMAND_P99)',
  errors: 'an error-reply burst',
  churn: 'connection churn',
  saturation: 'saturation',
};

const TRIGGER_PATTERN = /Trigger: ([^.]+)\./;

export function retryAmplificationMaxPollGap(pollIntervalMs: number): number {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) return RETRY_AMP_MAX_POLL_GAP_MS;
  return Math.max(RETRY_AMP_MAX_POLL_GAP_MS, pollIntervalMs * RETRY_AMP_POLL_GAP_MULTIPLIER);
}

export function createRetryAmplificationState(
  maxPollGapMs: number = RETRY_AMP_MAX_POLL_GAP_MS,
): RetryAmplificationState {
  return {
    maxPollGapMs,
    last: null,
    window: null,
    closing: null,
    coldWindows: [],
    hotRun: [],
    coldStreak: 0,
    episodeLevel: 'none',
    ackedLevel: 'none',
    pending: null,
    lastEpisode: null,
  };
}

function openWindow(start: number): OpenWindow {
  return {
    start,
    coveredMs: 0,
    opsSum: 0,
    opsCount: 0,
    clientsSum: 0,
    clientsCount: 0,
    commands: 0,
    commandsMs: 0,
    errors: 0,
    errorsMs: 0,
    churnSum: 0,
    churnCount: 0,
    latencyEvent: false,
    saturationMetrics: new Set(),
  };
}

function isUsable(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function medianOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : median(present);
}

function computeBaseline(windows: RetryAmplificationWindow[]): WindowBaseline {
  return {
    opsPerSec: median(windows.map((w) => w.opsPerSec)),
    connectedClients: median(windows.map((w) => w.connectedClients)),
    cmdsPerClient: median(windows.map((w) => w.cmdsPerClient)),
    errorRate: medianOrNull(windows.map((w) => w.errorRate)),
    churnPerSec: medianOrNull(windows.map((w) => w.churnPerSec)),
  };
}

function summarize(open: OpenWindow): RetryAmplificationWindow | null {
  if (open.coveredMs < RETRY_AMP_WINDOW_MS * RETRY_AMP_MIN_COVERAGE) return null;
  if (open.opsCount === 0 || open.clientsCount === 0 || open.commandsMs === 0) return null;
  const opsPerSec = open.opsSum / open.opsCount;
  const connectedClients = open.clientsSum / open.clientsCount;
  if (connectedClients <= 0) return null;
  return {
    start: open.start,
    opsPerSec,
    connectedClients,
    cmdsPerClient: open.commands / (open.commandsMs / 1000) / connectedClients,
    errorRate: open.errorsMs > 0 ? open.errors / (open.errorsMs / 1000) : null,
    churnPerSec: open.churnCount > 0 ? open.churnSum / open.churnCount : null,
    latencyEvent: open.latencyEvent,
    saturationMetrics: [...open.saturationMetrics],
  };
}

function hasLoadWithoutNewClients(w: RetryAmplificationWindow, base: WindowBaseline): boolean {
  if (base.opsPerSec <= 0 || base.connectedClients <= 0 || base.cmdsPerClient <= 0) return false;
  return (
    w.cmdsPerClient >= base.cmdsPerClient * RETRY_AMP_CMDS_PER_CLIENT_RATIO &&
    w.opsPerSec >= base.opsPerSec * RETRY_AMP_OPS_RATIO &&
    Math.abs(w.connectedClients / base.connectedClients - 1) <= RETRY_AMP_CLIENT_TOLERANCE
  );
}

function hasErrorStress(w: RetryAmplificationWindow, base: WindowBaseline): boolean {
  if (w.errorRate === null) return false;
  const floor = Math.max(
    (base.errorRate ?? 0) * RETRY_AMP_STRESS_RATIO,
    RETRY_AMP_ERROR_FLOOR_PER_SEC,
  );
  return w.errorRate >= floor;
}

function hasChurnStress(w: RetryAmplificationWindow, base: WindowBaseline): boolean {
  if (w.churnPerSec === null) return false;
  const floor = Math.max(
    (base.churnPerSec ?? 0) * RETRY_AMP_STRESS_RATIO,
    RETRY_AMP_CHURN_FLOOR_PER_SEC,
  );
  return w.churnPerSec >= floor;
}

function isHot(w: RetryAmplificationWindow, base: WindowBaseline): boolean {
  if (!hasLoadWithoutNewClients(w, base)) return false;
  return w.latencyEvent || hasErrorStress(w, base) || hasChurnStress(w, base);
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function slope(values: number[]): number {
  const n = values.length;
  const mx = (n - 1) / 2;
  const my = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (values[i] - my);
    den += (i - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

interface CoMovement {
  r: number;
  sustainedLatency: boolean;
}

function coMovement(run: RetryAmplificationWindow[]): CoMovement | null {
  const load = run.map((w) => w.cmdsPerClient);
  const series: Array<Array<number | null>> = [
    run.map((w) => w.errorRate),
    run.map((w) => w.churnPerSec),
  ];
  let best: CoMovement | null = null;
  for (const s of series) {
    if (s.some((v) => v === null)) continue;
    const r = pearson(load, s as number[]);
    if (r !== null && (best === null || r > best.r)) best = { r, sustainedLatency: false };
  }
  if (run[run.length - 1].latencyEvent) {
    const r = pearson(
      load,
      load.map((_, i) => i),
    );
    if (r !== null && (best === null || r > best.r)) best = { r, sustainedLatency: true };
  }
  return best;
}

function findTrigger(
  run: RetryAmplificationWindow[],
  base: WindowBaseline,
): RetryAmplificationTrigger {
  for (const w of run) {
    if (w.latencyEvent) return 'latency';
    if (hasErrorStress(w, base)) return 'errors';
    if (hasChurnStress(w, base)) return 'churn';
    if (w.saturationMetrics.length > 0) return 'saturation';
  }
  return 'latency';
}

function collectRelatedMetrics(
  run: RetryAmplificationWindow[],
  base: WindowBaseline,
  trigger: RetryAmplificationTrigger,
): MetricType[] {
  const related = new Set<MetricType>();
  if (trigger === 'latency') related.add(MetricType.COMMAND_P99);
  if (trigger === 'churn') related.add(MetricType.CONNECTION_CHURN);
  for (const w of run) {
    if (w.latencyEvent) related.add(MetricType.COMMAND_P99);
    if (hasChurnStress(w, base)) related.add(MetricType.CONNECTION_CHURN);
    for (const m of w.saturationMetrics) related.add(m);
  }
  return [...related];
}

function buildMessage(
  level: 'warning' | 'critical',
  trigger: RetryAmplificationTrigger,
  windows: number,
  loadRatio: number,
  correlation: number,
  clients: number,
  sustainedLatency: boolean,
): string {
  const minutes = (windows * RETRY_AMP_WINDOW_MS) / 60_000;
  const outcome =
    level === 'critical'
      ? 'The loop has reached saturation and is now starving the server.'
      : 'Without client backoff the loop keeps feeding itself.';
  return (
    `${level === 'critical' ? 'CRITICAL' : 'WARNING'}: Retry amplification — commands per ` +
    `client at ${loadRatio.toFixed(1)}× baseline for ${minutes} min while connected clients ` +
    `stay flat at ~${Math.round(clients)}; ` +
    (sustainedLatency
      ? 'load keeps climbing under a sustained latency regression '
      : 'load is rising with stress ') +
    `(r=${correlation.toFixed(2)}). Trigger: ${TRIGGER_LABEL[trigger]}. ${outcome}`
  );
}

export function readRetryAmplificationTrigger(message: string): string | null {
  const match = TRIGGER_PATTERN.exec(message);
  return match ? match[1] : null;
}

function classifyRun(
  state: RetryAmplificationState,
  base: WindowBaseline,
  timestamp: number,
): RetryAmplificationFinding | null {
  const run = state.hotRun;
  if (run.length < RETRY_AMP_MIN_WINDOWS) return null;
  const loads = run.map((w) => w.cmdsPerClient);
  if (slope(loads) < 0) return null;
  const movement = coMovement(run);
  if (movement === null || movement.r < RETRY_AMP_MIN_CORRELATION) return null;
  const correlation = movement.r;

  const latest = run[run.length - 1];
  const level = latest.saturationMetrics.length > 0 ? 'critical' : 'warning';
  const trigger = findTrigger(run, base);
  const loadRatio = latest.cmdsPerClient / base.cmdsPerClient;
  return {
    level,
    trigger,
    windows: run.length,
    loadRatio,
    correlation,
    connectedClients: latest.connectedClients,
    relatedMetrics: collectRelatedMetrics(run, base, trigger),
    message: buildMessage(
      level,
      trigger,
      run.length,
      loadRatio,
      correlation,
      latest.connectedClients,
      movement.sustainedLatency,
    ),
    timestamp,
  };
}

function closeEpisode(state: RetryAmplificationState, endedAt: number, base: WindowBaseline): void {
  const run = state.hotRun;
  if (run.length > 0) {
    const classification: RetryAmplificationEpisodeClass =
      state.episodeLevel !== 'none'
        ? 'amplifying'
        : run.length < RETRY_AMP_MIN_WINDOWS
          ? 'transient'
          : 'unconfirmed';
    state.lastEpisode = {
      classification,
      level: state.episodeLevel,
      trigger: findTrigger(run, base),
      windows: run.length,
      startedAt: run[0].start,
      endedAt,
    };
  }
  state.hotRun = [];
  state.coldStreak = 0;
  state.episodeLevel = 'none';
  state.ackedLevel = 'none';
  state.pending = null;
}

function pushCold(state: RetryAmplificationState, w: RetryAmplificationWindow): void {
  state.coldWindows.push(w);
  if (state.coldWindows.length > RETRY_AMP_BASELINE_WINDOWS) {
    state.coldWindows.splice(0, state.coldWindows.length - RETRY_AMP_BASELINE_WINDOWS);
  }
}

function evaluateWindow(
  state: RetryAmplificationState,
  w: RetryAmplificationWindow,
  timestamp: number,
): void {
  if (state.coldWindows.length < RETRY_AMP_ARM_WINDOWS) {
    pushCold(state, w);
    return;
  }

  const base = computeBaseline(state.coldWindows);
  if (!isHot(w, base)) {
    if (state.hotRun.length === 0) {
      pushCold(state, w);
      return;
    }
    state.coldStreak += 1;
    const amplifying = state.hotRun.length >= RETRY_AMP_MIN_WINDOWS;
    if (!amplifying || state.coldStreak >= RETRY_AMP_REARM_COLD_WINDOWS) {
      closeEpisode(state, w.start + RETRY_AMP_WINDOW_MS, base);
      pushCold(state, w);
    }
    return;
  }

  state.coldStreak = 0;
  state.hotRun.push(w);
  const finding = classifyRun(state, base, timestamp);
  if (finding === null) return;

  state.episodeLevel =
    LEVEL_RANK[finding.level] > LEVEL_RANK[state.episodeLevel] ? finding.level : state.episodeLevel;
  if (LEVEL_RANK[finding.level] < LEVEL_RANK[state.ackedLevel]) {
    state.ackedLevel = finding.level;
  }
  if (LEVEL_RANK[finding.level] > LEVEL_RANK[state.ackedLevel]) {
    state.pending = finding;
  }
}

function markEvents(open: OpenWindow, events: RetryAmplificationEventRef[]): void {
  const end = open.start + RETRY_AMP_WINDOW_MS;
  for (const e of events) {
    if (e.timestamp < open.start || e.timestamp >= end) continue;
    if (RETRY_AMP_STRESS_METRICS.includes(e.metricType)) open.latencyEvent = true;
    if (RETRY_AMP_SATURATION_METRICS.includes(e.metricType))
      open.saturationMetrics.add(e.metricType);
  }
}

function finalizeClosing(state: RetryAmplificationState, timestamp: number): void {
  if (state.closing === null) return;
  const closed = summarize(state.closing);
  state.closing = null;
  if (closed !== null) evaluateWindow(state, closed, timestamp);
}

export function evaluateRetryAmplification(
  state: RetryAmplificationState,
  sample: RetryAmplificationSample,
): RetryAmplificationFinding | null {
  const last = state.last;
  if (
    last !== null &&
    isUsable(sample.totalCommands) &&
    isUsable(last.totalCommands) &&
    sample.totalCommands < last.totalCommands
  ) {
    Object.assign(state, createRetryAmplificationState(state.maxPollGapMs), {
      lastEpisode: state.lastEpisode,
    });
  }

  if (state.window === null) {
    state.window = openWindow(sample.timestamp);
  } else if (sample.timestamp - state.window.start >= RETRY_AMP_WINDOW_MS) {
    finalizeClosing(state, sample.timestamp);
    const elapsed = Math.floor((sample.timestamp - state.window.start) / RETRY_AMP_WINDOW_MS);
    state.closing = elapsed === 1 ? state.window : null;
    if (elapsed > 1) {
      const closed = summarize(state.window);
      if (closed !== null) evaluateWindow(state, closed, sample.timestamp);
    }
    state.window = openWindow(state.window.start + elapsed * RETRY_AMP_WINDOW_MS);
  }

  if (state.closing !== null) {
    markEvents(state.closing, sample.recentEvents);
    if (sample.timestamp >= state.closing.start + RETRY_AMP_WINDOW_MS + RETRY_AMP_EVENT_GRACE_MS) {
      finalizeClosing(state, sample.timestamp);
    }
  }

  const open = state.window;
  if (isUsable(sample.opsPerSec)) {
    open.opsSum += sample.opsPerSec;
    open.opsCount += 1;
  }
  if (isUsable(sample.connectedClients)) {
    open.clientsSum += sample.connectedClients;
    open.clientsCount += 1;
  }
  if (isUsable(sample.connectsPerSec)) {
    open.churnSum += sample.connectsPerSec;
    open.churnCount += 1;
  }
  markEvents(open, sample.recentEvents);
  if (sample.stressActive) open.latencyEvent = true;
  for (const m of sample.activeSaturation ?? []) open.saturationMetrics.add(m);

  const prev = state.last;
  if (prev !== null) {
    const dt = sample.timestamp - prev.timestamp;
    if (dt > 0 && dt <= state.maxPollGapMs) {
      open.coveredMs += dt;
      if (isUsable(sample.totalCommands) && isUsable(prev.totalCommands)) {
        open.commands += sample.totalCommands - prev.totalCommands;
        open.commandsMs += dt;
      }
      if (
        isUsable(sample.totalErrorReplies) &&
        isUsable(prev.totalErrorReplies) &&
        sample.totalErrorReplies >= prev.totalErrorReplies
      ) {
        open.errors += sample.totalErrorReplies - prev.totalErrorReplies;
        open.errorsMs += dt;
      }
    }
  }
  state.last = {
    timestamp: sample.timestamp,
    totalCommands: sample.totalCommands,
    totalErrorReplies: sample.totalErrorReplies,
  };

  return state.pending;
}

export interface RetryAmplificationStatus {
  armed: boolean;
  classification: 'none' | 'candidate' | 'amplifying';
  level: RetryAmplificationLevel;
  windows: number;
  baseline: WindowBaseline | null;
  lastEpisode: RetryAmplificationEpisode | null;
}

export function describeRetryAmplificationState(
  state: RetryAmplificationState | undefined,
): RetryAmplificationStatus {
  if (state === undefined) {
    return {
      armed: false,
      classification: 'none',
      level: 'none',
      windows: 0,
      baseline: null,
      lastEpisode: null,
    };
  }
  const armed = state.coldWindows.length >= RETRY_AMP_ARM_WINDOWS;
  const classification =
    state.hotRun.length === 0 ? 'none' : state.episodeLevel !== 'none' ? 'amplifying' : 'candidate';
  return {
    armed,
    classification,
    level: state.episodeLevel,
    windows: state.hotRun.length,
    baseline: armed ? computeBaseline(state.coldWindows) : null,
    lastEpisode: state.lastEpisode,
  };
}

export function retryAmplificationEpisodeStart(state: RetryAmplificationState): number | null {
  return state.hotRun.length > 0 ? state.hotRun[0].start : null;
}

export function acknowledgeRetryAmplificationFinding(
  state: RetryAmplificationState,
  finding: RetryAmplificationFinding,
): void {
  state.ackedLevel = finding.level;
  if (state.pending === finding) state.pending = null;
}
