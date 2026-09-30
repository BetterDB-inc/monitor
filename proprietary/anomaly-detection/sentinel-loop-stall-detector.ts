/**
 * Sentinel loop-stall / TILT detection.
 *
 * Valkey Sentinel is single-threaded. When `resolve-hostnames yes` is set and the
 * monitored/announced targets are FQDNs, Sentinel resolves hostnames with a
 * blocking `getaddrinfo` on its main event loop. Slow DNS stalls the loop past the
 * 2000ms TILT trigger, so Sentinel enters TILT — which suppresses `+sdown`. A
 * SEPARATE failure, misdirected/unreachable resolution (split-horizon), produces
 * real `+sdown` with NO TILT and a healthy loop. This detector fires on the stall
 * and, when it can, classifies which of the two failure modes it is looking at.
 *
 * Full writeup and reproduction harness:
 * https://github.com/BetterDB-inc/valkey-sentinel-tilt-repro
 *
 * ## Three signals, one module
 *
 * 1. Direct TILT (highest confidence): `sentinel_tilt_since_seconds >= 0` in the
 *    INFO "# Sentinel" section says the loop already stalled past the trigger. An
 *    episode is modelled with entry/duration/exit so the alert fires once, not on
 *    every poll.
 * 2. RTT proxy (leading indicator): the INFO round-trip time doubles as a probe of
 *    loop latency. K of the last N samples over a warn threshold means the loop is
 *    stalling and approaching the TILT trigger — visible BEFORE TILT engages. A
 *    total wedge where INFO itself times out (while the TCP socket stays up) is the
 *    worst case of the same signal.
 * 3. Classification: fused with the Sentinel view. TILT / RTT stall / timeout imply
 *    loop starvation (the blocking-DNS hypothesis). A monitored master reported
 *    down while the loop is demonstrably healthy (no TILT, RTT flat) is the OTHER
 *    failure: misdirected / unreachable resolution.
 *
 * Pure: no I/O. The service reads the INFO fields and the Sentinel master view and
 * hands them in; this module only folds them into per-connection state and returns
 * findings. Mirrors the pure-detector shape of sentinel-drift-detector.ts.
 */

/** TILT trigger constant from Valkey sentinel.c (`sentinel_tilt_trigger`, ms). */
export const SENTINEL_TILT_TRIGGER_MS = 2000;

export type SentinelLoopStallKind = 'tilt' | 'rtt_stall' | 'timeout_wedge' | 'misdirected_resolution';

export type SentinelLoopStallSeverity = 'warning' | 'critical';

/**
 * Which of the two failure modes the evidence points at.
 * - `loop_starvation_dns`: the loop stalled (likely blocking hostname resolution).
 * - `misdirected_resolution`: a master is down but the loop is healthy — a
 *   split-horizon / unreachable-address problem, NOT a stall.
 */
export type SentinelStallClassification =
  | 'loop_starvation_dns'
  | 'misdirected_resolution';

export interface SentinelLoopStallThresholds {
  /** RTT (ms) at/above which a sample is a warn-level breach. Default ~1500 (below the 2000ms trigger). */
  warnRttMs: number;
  /** RTT (ms) at/above which a sample is a high-level breach. Tied to sentinel_tilt_trigger (2000). */
  highRttMs: number;
  /** Window size N for the K-of-N RTT proxy. */
  rttWindow: number;
  /** Minimum breaches K within the window before an RTT stall is raised. */
  rttMinBreaches: number;
  /**
   * Consecutive FRESH Sentinel-view observations (not polls) of a "master down but
   * loop healthy" condition before it is classified as misdirected resolution — so a
   * normal transient failover `+sdown` does not alert, and a single stale snapshot
   * cannot drive it on its own.
   */
  misdirectedMinStreak: number;
}

/**
 * Defaults. RTT thresholds bracket the 2000ms TILT trigger: warn well below it so
 * the leading indicator has room to fire, high AT the trigger. Window/breaches are
 * a small K-of-N so a single slow poll (GC pause on our side, one blip) does not
 * alert. Kept here so both the service defaults and the tests share one source.
 */
export const DEFAULT_SENTINEL_LOOP_STALL_THRESHOLDS: SentinelLoopStallThresholds = {
  warnRttMs: 1500,
  highRttMs: SENTINEL_TILT_TRIGGER_MS,
  rttWindow: 10,
  rttMinBreaches: 3,
  // Consecutive FRESH Sentinel-view observations (each ~15s apart), not polls:
  // 3 ≈ 45s of re-verified, sustained down-with-healthy-loop. Long enough that a
  // normal in-progress failover (master down until a replica is promoted, usually
  // seconds) clears before it fires, while a persistent split-horizon sdown that
  // never recovers still trips it. Counting fresh observations rather than polls
  // keeps one stale snapshot from advancing the streak on its own.
  misdirectedMinStreak: 3,
};

export interface SentinelLoopStallInput {
  timestamp: number;
  /**
   * Parsed `sentinel_tilt_since_seconds`: >= 0 is seconds spent in TILT, -1 means
   * not in TILT. null when the field is absent (older servers) — fall back to the
   * flag.
   */
  tiltSinceSeconds: number | null;
  /** Parsed `sentinel_tilt` (true when 1). null when the field is absent. */
  tiltFlag: boolean | null;
  /** INFO round-trip time for this poll (ms), or null when unmeasured (e.g. INFO timed out). */
  probeRttMs: number | null;
  /**
   * INFO/command timed out this poll while the TCP socket stayed up — a total loop
   * wedge. Must not be read as "connection down".
   */
  commandTimedOut: boolean;
  /**
   * Fresh observation of whether any monitored master carries `s_down`/`o_down`:
   * `true`/`false` from a NEWLY refreshed Sentinel view, or `null` when this poll had
   * no fresh view. The `SENTINEL MASTERS` snapshot refreshes on a slower cadence than
   * we poll, so a `null` here holds the streak — stale evidence must not advance it.
   */
  masterDownObserved: boolean | null;
  thresholds: SentinelLoopStallThresholds;
}

export interface SentinelLoopStallFinding {
  kind: SentinelLoopStallKind;
  severity: SentinelLoopStallSeverity;
  classification: SentinelStallClassification;
  /**
   * Seconds in TILT for a `tilt` finding: the authoritative `tilt_since_seconds`
   * when the server reports it, else our own observed episode length. null for the
   * non-TILT kinds.
   */
  tiltDurationSeconds: number | null;
  /** The worst RTT in the current window (ms), for the message. null when no sample. */
  observedRttMs: number | null;
  /** Warn-level breaches within the window at emit time, for the message. */
  breachCount: number;
}

export interface SentinelLoopStallState {
  /** Whether the previous poll observed TILT — the edge for episode entry/exit. */
  inTilt: boolean;
  /**
   * Monitor-clock ms when the current TILT episode was first observed. Used only
   * as a duration FALLBACK when the server does not report `tilt_since_seconds`.
   */
  tiltEpisodeStartMs: number | null;
  /** Rolling window of the last N INFO RTT samples for the K-of-N proxy. */
  rttSamples: number[];
  /** Consecutive polls the "master down but loop healthy" condition has held. */
  misdirectedStreak: number;
}

export function createSentinelLoopStallState(): SentinelLoopStallState {
  return {
    inTilt: false,
    tiltEpisodeStartMs: null,
    rttSamples: [],
    misdirectedStreak: 0,
  };
}

/**
 * TILT truth for this poll. The seconds field is authoritative when present; the
 * boolean flag is the fallback for older servers that don't emit it. Absent both,
 * we cannot claim TILT.
 */
function isInTilt(input: SentinelLoopStallInput): boolean {
  if (input.tiltSinceSeconds !== null) {
    return input.tiltSinceSeconds >= 0;
  }
  if (input.tiltFlag !== null) {
    return input.tiltFlag === true;
  }
  return false;
}

/**
 * Folds one poll into the episode/window state and returns the findings to emit
 * (0 or 1). The caller applies the persistence/dedupe gate, so returning the same
 * finding while a condition holds is expected — the gate emits it once per episode.
 * Mutates `state`.
 *
 * Exactly one condition is reported per poll, in priority order: an active TILT
 * outranks the RTT proxy (which is only a leading indicator of the same stall),
 * a total wedge outranks a plain RTT stall, and the misdirected-resolution signal
 * is considered only when the loop is demonstrably healthy.
 */
export function evaluateSentinelLoopStall(
  state: SentinelLoopStallState,
  input: SentinelLoopStallInput,
): SentinelLoopStallFinding[] {
  const { thresholds } = input;

  // RTT window bookkeeping (a timed-out poll contributes no sample).
  if (input.probeRttMs !== null) {
    state.rttSamples.push(input.probeRttMs);
    if (state.rttSamples.length > thresholds.rttWindow) {
      state.rttSamples.shift();
    }
  }
  const warnBreaches = state.rttSamples.filter((v) => v >= thresholds.warnRttMs).length;
  const highBreaches = state.rttSamples.filter((v) => v >= thresholds.highRttMs).length;
  const worstRtt = state.rttSamples.length > 0 ? Math.max(...state.rttSamples) : null;
  const rttStalling = warnBreaches >= thresholds.rttMinBreaches;
  const rttSevere = highBreaches >= thresholds.rttMinBreaches;

  // TILT episode edges.
  const nowInTilt = isInTilt(input);
  if (nowInTilt && !state.inTilt) {
    state.tiltEpisodeStartMs = input.timestamp;
  } else if (!nowInTilt && state.inTilt) {
    state.tiltEpisodeStartMs = null;
  }
  state.inTilt = nowInTilt;

  // 1) Active TILT — highest confidence. The RTT stall, if any, is the same event
  //    seen through a different lens, so it is folded in here rather than emitted
  //    separately.
  if (nowInTilt) {
    state.misdirectedStreak = 0;
    const authoritative = input.tiltSinceSeconds !== null && input.tiltSinceSeconds >= 0;
    const tiltDurationSeconds = authoritative
      ? input.tiltSinceSeconds
      : state.tiltEpisodeStartMs !== null
        ? Math.floor((input.timestamp - state.tiltEpisodeStartMs) / 1000)
        : null;
    return [
      {
        kind: 'tilt',
        severity: 'critical',
        classification: 'loop_starvation_dns',
        tiltDurationSeconds,
        observedRttMs: worstRtt,
        breachCount: warnBreaches,
      },
    ];
  }

  // 2) Total wedge — INFO stopped answering while the socket stayed up. The worst
  //    form of the RTT stall; report before it is mistaken for a dead connection.
  if (input.commandTimedOut) {
    state.misdirectedStreak = 0;
    return [
      {
        kind: 'timeout_wedge',
        severity: 'critical',
        classification: 'loop_starvation_dns',
        tiltDurationSeconds: null,
        observedRttMs: worstRtt,
        breachCount: warnBreaches,
      },
    ];
  }

  // 3) RTT stall — leading indicator, no TILT yet.
  if (rttStalling) {
    state.misdirectedStreak = 0;
    return [
      {
        kind: 'rtt_stall',
        severity: rttSevere ? 'critical' : 'warning',
        classification: 'loop_starvation_dns',
        tiltDurationSeconds: null,
        observedRttMs: worstRtt,
        breachCount: warnBreaches,
      },
    ];
  }

  // 4) Misdirected resolution — a master is down yet the loop is healthy (no TILT,
  //    RTT not stalling). The OTHER failure mode. Required to persist across fresh
  //    observations so a normal transient failover `+sdown` does not alert. A `null`
  //    observation (no fresh Sentinel view this poll) HOLDS the streak: stale
  //    evidence must neither advance nor clear it — only fresh evidence moves it.
  if (input.masterDownObserved === true) {
    // Cap at the threshold: once confirmed, there is nothing to gain from letting the
    // counter grow without bound while the condition persists.
    state.misdirectedStreak = Math.min(
      state.misdirectedStreak + 1,
      thresholds.misdirectedMinStreak,
    );
  } else if (input.masterDownObserved === false) {
    state.misdirectedStreak = 0;
  }

  // Emit whenever the streak is at/above threshold — INCLUDING on null (stale) polls
  // once it has been confirmed. The persistence gate clears an active finding the
  // instant a poll returns none, so a gap here would let the very next fresh
  // observation re-emit a duplicate warning on every snapshot refresh. A fresh
  // `false` observation resets the streak and ends the finding, which re-arms it.
  if (state.misdirectedStreak >= thresholds.misdirectedMinStreak) {
    return [
      {
        kind: 'misdirected_resolution',
        severity: 'warning',
        classification: 'misdirected_resolution',
        tiltDurationSeconds: null,
        observedRttMs: worstRtt,
        breachCount: warnBreaches,
      },
    ];
  }

  return [];
}

/**
 * Stable per-connection signature. One Sentinel connection has one event loop, so
 * the kind alone dedupes an episode across polls while a change of kind (e.g. an
 * RTT stall escalating into a wedge, or a new TILT episode after recovery) alerts
 * again. Percent-encoded for symmetry with sentinel-drift-detector, though `kind`
 * is a fixed enum and never contains the separator.
 */
export function sentinelLoopStallSignature(finding: SentinelLoopStallFinding): string {
  return ['sentinel-loop-stall', finding.kind].map(encodeURIComponent).join('|');
}
