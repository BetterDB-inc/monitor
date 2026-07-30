/**
 * Event-loop load saturation detection (valkey-io/valkey#2055): on a
 * (largely) single-threaded server, raw CPU% is a poor busyness indicator —
 * a loop that spends nearly all of its wall-clock time doing real work can
 * still report a modest CPU% (kernel accounting, hyperthreading, IO waits,
 * multi-core hosts where one saturated core is a fraction of the total). The
 * true busyness signal is how much of wall-clock time the event loop is busy,
 * which Valkey exposes directly via INFO stats:
 *
 *   busyFraction = (instantaneous_eventloop_duration_usec *
 *                   instantaneous_eventloop_cycles_per_sec) / 1_000_000
 *
 * i.e. average microseconds of work per cycle times cycles per second, over a
 * one-second wall clock — the fraction of wall time the loop was busy, clamped
 * to [0,1]. When this is high the server is saturated regardless of what CPU%
 * says, and the fix is almost never "add CPU": it is to find the slow
 * commands / big O(N) operations / single-thread bottleneck starving the loop.
 *
 * The evaluator is re-entrant on an external per-connection state object (the
 * anomaly service holds one per connection) and follows the client-saturation
 * hysteresis contract: it fires only when the level ESCALATES above what was
 * last acknowledged, keeps returning the finding until the caller
 * acknowledges a successful emit (so a failed emit retries next poll), and
 * re-arms when busyness falls back below the warning threshold. To keep a
 * momentary batch or burst from alerting, a level must hold for
 * LOAD_CONSECUTIVE_REQUIRED consecutive polls before it fires.
 */

/** Fraction of wall-clock time the event loop is busy that triggers a WARNING. */
export const LOAD_WARN_FRACTION = 0.8;
/** Busy fraction that triggers a CRITICAL. */
export const LOAD_CRIT_FRACTION = 0.95;
/**
 * Number of consecutive polls a level must hold before it fires, so a single
 * batch job / pipeline burst does not raise an alert.
 */
export const LOAD_CONSECUTIVE_REQUIRED = 3;
/**
 * How far (in percentage points) CPU% must sit BELOW the busy percentage
 * before the message calls out that CPU% is understating the load — the core
 * point of #2055. A small gap is expected noise; a large one is the signature
 * of the metric being misleading.
 */
export const LOAD_CPU_UNDERSTATE_GAP = 15;

export type LoadLevel = 'none' | 'warning' | 'critical';

export interface LoadSaturationInput {
  /** INFO stats instantaneous_eventloop_duration_usec — avg microseconds of work per cycle. */
  eventloopDurationUsecPerCycle: number | null;
  /** INFO stats instantaneous_eventloop_cycles_per_sec — event-loop cycles per second. */
  eventloopCyclesPerSec: number | null;
  /** The CPU utilization sample computed in the same poll (percent), for the contrast. */
  cpuUtilizationPct: number | null;
  /** INFO stats instantaneous_ops_per_sec, for context in the message. */
  opsPerSec: number | null;
  timestamp: number;
}

export interface LoadSaturationState {
  /** Highest level already emitted-and-acknowledged; re-armed to 'none' on a drop. */
  ackedLevel: LoadLevel;
  /** Consecutive polls at or above the warning threshold, reset on a below-warning sample. */
  consecutive: number;
}

export interface LoadSaturationFinding {
  level: 'warning' | 'critical';
  busyFraction: number;
  message: string;
  timestamp: number;
}

const LEVEL_RANK: Record<LoadLevel, number> = { none: 0, warning: 1, critical: 2 };

export function createLoadSaturationState(): LoadSaturationState {
  return { ackedLevel: 'none', consecutive: 0 };
}

function classify(busyFraction: number): LoadLevel {
  if (busyFraction >= LOAD_CRIT_FRACTION) return 'critical';
  if (busyFraction >= LOAD_WARN_FRACTION) return 'warning';
  return 'none';
}

function buildMessage(
  level: 'warning' | 'critical',
  busyFraction: number,
  input: LoadSaturationInput,
): string {
  const busyPct = busyFraction * 100;
  const cyclesPart =
    input.eventloopCyclesPerSec !== null
      ? `${Math.round(input.eventloopCyclesPerSec).toLocaleString()} event-loop cycles/sec`
      : 'event-loop cycles';
  const opsPart =
    input.opsPerSec !== null ? `, ${Math.round(input.opsPerSec).toLocaleString()} ops/sec` : '';

  // The whole point of #2055: CPU% can look comfortable while the single loop
  // is pinned. Call it out explicitly when the gap is large enough to mislead.
  let cpuPart: string;
  const cpu = input.cpuUtilizationPct;
  if (cpu !== null && cpu < busyPct - LOAD_CPU_UNDERSTATE_GAP) {
    cpuPart =
      ` CPU utilization reads only ${cpu.toFixed(1)}%, which UNDERSTATES the real load — ` +
      `on a largely single-threaded server CPU% is not a comprehensive busyness indicator ` +
      `(valkey#2055).`;
  } else if (cpu !== null) {
    cpuPart = ` (CPU utilization ${cpu.toFixed(1)}%.)`;
  } else {
    cpuPart = '';
  }

  return (
    `${level === 'critical' ? 'CRITICAL' : 'WARNING'}: Event loop busy ${busyPct.toFixed(1)}% ` +
    `of wall-clock time (${cyclesPart}${opsPart}) — the server is ${
      level === 'critical' ? 'saturated' : 'approaching saturation'
    } and cannot do meaningfully more work.${cpuPart} Look for slow commands, big O(N) ` +
    `operations (KEYS, large SMEMBERS/HGETALL, unbounded ranges), or a single-thread ` +
    `bottleneck rather than just adding CPU (valkey#2055).`
  );
}

/**
 * Folds one poll's event-loop sample into the connection state and returns a
 * finding to emit, or null. The eventloop fields are OPTIONAL (older servers
 * omit them); when either is missing/unparseable the detector is a graceful
 * no-op (returns null) and never fabricates busyness from CPU%. A finding
 * keeps being returned until `acknowledgeLoadSaturationFinding` is called.
 */
export function evaluateLoadSaturation(
  state: LoadSaturationState,
  input: LoadSaturationInput,
): LoadSaturationFinding | null {
  const duration = input.eventloopDurationUsecPerCycle;
  const cycles = input.eventloopCyclesPerSec;
  // Graceful no-op on older servers that don't expose the fields. A negative
  // value would be nonsensical (counters never go below zero here) — treat it
  // as unavailable rather than deriving a bogus fraction.
  if (
    duration === null ||
    cycles === null ||
    Number.isFinite(duration) === false ||
    Number.isFinite(cycles) === false ||
    duration < 0 ||
    cycles < 0
  ) {
    return null;
  }

  const rawFraction = (duration * cycles) / 1_000_000;
  const busyFraction = Math.max(0, Math.min(1, rawFraction));
  const level = classify(busyFraction);

  if (level === 'none') {
    // A below-warning sample re-arms alerting (drop) and resets the consecutive
    // counter so a fresh burst must build up again from scratch.
    state.consecutive = 0;
    state.ackedLevel = 'none';
    return null;
  }

  state.consecutive += 1;
  if (state.consecutive < LOAD_CONSECUTIVE_REQUIRED) {
    return null;
  }

  // Escalation-only: emit only when the level rises above what's acknowledged.
  const escalated = LEVEL_RANK[level] > LEVEL_RANK[state.ackedLevel];
  if (escalated === false) {
    return null;
  }

  return {
    level,
    busyFraction,
    message: buildMessage(level, busyFraction, input),
    timestamp: input.timestamp,
  };
}

/**
 * Advances the stored hysteresis level after a finding was successfully
 * emitted, so a steady saturation does not re-emit every poll. A failed emit
 * simply isn't acknowledged, so the same escalation is retried next poll.
 */
export function acknowledgeLoadSaturationFinding(
  state: LoadSaturationState,
  finding: LoadSaturationFinding,
): void {
  state.ackedLevel = finding.level;
}
