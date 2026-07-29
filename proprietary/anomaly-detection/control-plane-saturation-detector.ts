import { AnomalyEvent, AnomalyPattern, AnomalySeverity, AnomalyType, MetricType } from './types';

/**
 * Control-plane saturation detection (valkey-io/valkey#3927): Valkey's
 * single-threaded event loop gives every connection equal weight, so under
 * CPU saturation the control plane starves — cluster heartbeats and the
 * replication stream get delayed (false node timeouts, replica drops,
 * unnecessary failovers) and admin commands queue behind the data-traffic
 * backlog. Upstream's fix is a QoS framework for trusted sources; until it
 * lands, the observable condition is surfaced here.
 *
 * The design is the pairing: sustained CPU ≥90% for three consecutive polls
 * AND at least one piece of control-plane impact evidence. High CPU alone is
 * a busy-but-healthy server and never fires; an RTT blip alone is network
 * noise and never fires.
 *
 * The finding is emitted as ONE synthetic CRITICAL CPU_UTILIZATION anomaly
 * per episode (no dedicated MetricType — this is a correlator pattern, not a
 * standalone metric), built exclusively by `createControlPlaneSaturationEvent`,
 * which stamps an explicit `syntheticPattern` marker that
 * `isControlPlaneSaturationEvent` recognizes and the correlator maps to
 * CONTROL_PLANE_SATURATION — no message or numeric-shape sniffing. An episode
 * re-arms only after the CPU streak fully resets (recovery + re-trigger).
 */

export const SATURATION_CPU_PCT = 90;
export const SATURATION_MIN_STREAK = 3;
export const SATURATION_RTT_MULT = 4;
export const SATURATION_RTT_FLOOR_MS = 100;
export const SATURATION_CORROBORATION_WINDOW_MS = 60_000;

const RTT_SAMPLE_LIMIT = 30;
const RTT_MIN_SAMPLES = 5;

/** Anomaly metric types that count as control-plane impact evidence. */
export const CONTROL_PLANE_CORROBORATING_METRICS: MetricType[] = [
  MetricType.REPLICATION_ROLE,
  MetricType.CLUSTER_STATE,
  MetricType.CLUSTER_TOPOLOGY,
  MetricType.RAFT_HEALTH,
  MetricType.FAILOVER_CHURN,
  MetricType.REPL_BUFFER_PRESSURE,
];

export interface ControlPlaneState {
  cpuHighStreak: number;
  rttSamples: number[];
  episodeActive: boolean;
  /**
   * One entry per dropped replica, kept for the corroboration window: a drop
   * early in the CPU streak buildup must still corroborate once the streak
   * reaches the threshold, same as recent anomaly events. A single lone drop
   * is weak evidence (a replica removed for maintenance looks identical) and
   * corroborates only alongside a second signal; two or more drops in the
   * window — one mass drop or repeated drops — are the saturation signature
   * and corroborate on their own.
   */
  replicaDropTimes: number[];
  /**
   * Corroborating evidence must postdate this floor. Advanced when a finding
   * is emitted (CPU chatter around the threshold must not re-fire off the
   * previous episode's evidence) and on a server restart (restart-driven
   * role/cluster/COB events belong to the old process, not a new episode).
   */
  evidenceFloorAt: number | null;
}

export interface ControlPlaneInput {
  /** Server-side CPU utilization percent for this poll, or null when no sample. */
  cpuUtilization: number | null;
  /**
   * The used_cpu_* counters went backwards — a server restart. The saturation
   * episode ended with the old process, so all episode evidence resets;
   * carrying it would let a pre-restart streak pair with restart-driven
   * replica churn into a false CRITICAL.
   */
  cpuCounterReset: boolean;
  /** Round-trip time of this poll's INFO command, or null when unmeasured. */
  probeRttMs: number | null;
  /** How many replicas connected_slaves dropped by since the previous poll (0 = none). */
  replicaDropCount: number;
  /** Corroborating anomaly events within the recent window. */
  recentControlPlaneEvents: Array<{ metricType: string; timestamp: number }>;
  timestamp: number;
}

export interface SaturationFinding {
  cpuUtilization: number;
  corroboration: string;
  message: string;
}

export function createControlPlaneState(): ControlPlaneState {
  return {
    cpuHighStreak: 0,
    rttSamples: [],
    episodeActive: false,
    replicaDropTimes: [],
    evidenceFloorAt: null,
  };
}

function rollingMedian(samples: number[]): number | null {
  if (samples.length < RTT_MIN_SAMPLES) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => {
    return a - b;
  });
  return sorted[Math.floor(sorted.length / 2)];
}

interface RttJudgement {
  spike: boolean;
  baseline: number | null;
}

function judgeRtt(state: ControlPlaneState, probeRttMs: number | null): RttJudgement {
  if (probeRttMs === null) {
    return { spike: false, baseline: null };
  }
  const baseline = rollingMedian(state.rttSamples);
  const spike =
    baseline !== null &&
    probeRttMs >= SATURATION_RTT_FLOOR_MS &&
    probeRttMs >= baseline * SATURATION_RTT_MULT;
  state.rttSamples.push(probeRttMs);
  if (state.rttSamples.length > RTT_SAMPLE_LIMIT) {
    state.rttSamples.shift();
  }
  return { spike, baseline };
}

function describeCorroboration(
  input: ControlPlaneInput,
  rtt: RttJudgement,
  replicasDropped: number,
  freshEventTypes: string[],
): string | null {
  const reasons: string[] = [];
  if (rtt.spike && input.probeRttMs !== null && rtt.baseline !== null) {
    reasons.push(
      `probe RTT spiked to ${Math.round(input.probeRttMs)}ms (~${Math.round(rtt.baseline)}ms baseline)`,
    );
  }
  if (freshEventTypes.length > 0) {
    const unique = [...new Set(freshEventTypes)];
    reasons.push(`recent control-plane anomalies (${unique.join(', ')})`);
  }
  // A lone single-replica drop is indistinguishable from a replica removed
  // for maintenance under an unrelated CPU burst — it corroborates only
  // alongside a second signal. Two or more drops in the window (one mass
  // drop or repeated drops) are the saturation signature and stand alone.
  const replicaDropCorroborates =
    replicasDropped >= 2 || (replicasDropped === 1 && reasons.length > 0);
  if (replicaDropCorroborates === true) {
    const detail = replicasDropped === 1 ? '' : ` (${replicasDropped} within the window)`;
    reasons.push(`replica count dropped${detail}`);
  }
  if (reasons.length === 0) {
    return null;
  }
  return reasons.join('; ');
}

/**
 * Folds one poll's sample into the episode state and returns the finding to
 * emit, or null. The finding keeps being returned while the condition holds
 * until `acknowledgeSaturationFinding` marks the episode as alerted (so a
 * failed emit retries next poll). Mutates `state`.
 */
export function evaluateControlPlaneSaturation(
  state: ControlPlaneState,
  input: ControlPlaneInput,
): SaturationFinding | null {
  const rtt = judgeRtt(state, input.probeRttMs);

  if (input.cpuCounterReset) {
    state.cpuHighStreak = 0;
    state.episodeActive = false;
    state.replicaDropTimes = [];
    // Anomaly events raised around the restart (role changes, cluster-state,
    // COB) are restart fallout, not saturation impact evidence.
    state.evidenceFloorAt = input.timestamp;
    // The RTT baseline belongs to the old process too: startup load (RDB/AOF
    // replay) judged against it would spike-corroborate a loading server.
    state.rttSamples = [];
    return null;
  }

  for (let i = 0; i < input.replicaDropCount; i += 1) {
    state.replicaDropTimes.push(input.timestamp);
  }
  state.replicaDropTimes = state.replicaDropTimes.filter((t) => {
    return input.timestamp - t <= SATURATION_CORROBORATION_WINDOW_MS;
  });

  if (input.cpuUtilization !== null) {
    if (input.cpuUtilization >= SATURATION_CPU_PCT) {
      state.cpuHighStreak += 1;
    } else {
      state.cpuHighStreak = 0;
      state.episodeActive = false;
    }
  }

  if (state.cpuHighStreak < SATURATION_MIN_STREAK) {
    return null;
  }
  if (state.episodeActive) {
    return null;
  }

  // Evidence from before the floor belongs to a previous episode (or the
  // pre-restart process) and must not corroborate a new one.
  const evidenceFloor = state.evidenceFloorAt ?? -Infinity;
  const replicasDropped = state.replicaDropTimes.filter((t) => {
    return t > evidenceFloor;
  }).length;
  const freshEventTypes = input.recentControlPlaneEvents
    .filter((e) => {
      return e.timestamp > evidenceFloor;
    })
    .map((e) => {
      return e.metricType;
    });
  const corroboration = describeCorroboration(input, rtt, replicasDropped, freshEventTypes);
  if (corroboration === null) {
    return null;
  }

  const cpuUtilization = input.cpuUtilization ?? SATURATION_CPU_PCT;
  return {
    cpuUtilization,
    corroboration,
    message:
      `Engine near CPU saturation (${Math.round(cpuUtilization)}% for ` +
      `${state.cpuHighStreak} consecutive polls) with control-plane impact: ${corroboration} — ` +
      `cluster stability at risk (valkey#3927). Shed load or isolate expensive queries; ` +
      `upgrade to a QoS-capable version when the upstream feature lands.`,
  };
}

/** Marks the current episode as alerted after a successful emit. */
export function acknowledgeSaturationFinding(state: ControlPlaneState, timestamp: number): void {
  state.episodeActive = true;
  state.evidenceFloorAt = timestamp;
}

/**
 * The single constructor for the synthetic saturation event. Every emit goes
 * through here so the explicit `syntheticPattern` marker can never drift from
 * the recognizer below — recognition must never fall back to sniffing numeric
 * fields (a z-score CPU anomaly could collide on any numeric shape).
 */
export function createControlPlaneSaturationEvent(
  finding: SaturationFinding,
  id: string,
  timestamp: number,
  connectionId: string | undefined,
): AnomalyEvent {
  return {
    id,
    timestamp,
    metricType: MetricType.CPU_UTILIZATION,
    anomalyType: AnomalyType.SPIKE,
    severity: AnomalySeverity.CRITICAL,
    value: finding.cpuUtilization,
    baseline: 0,
    zScore: 0,
    stdDev: 0,
    threshold: SATURATION_CPU_PCT,
    message: `CRITICAL: ${finding.message}`,
    resolved: false,
    connectionId,
    syntheticPattern: AnomalyPattern.CONTROL_PLANE_SATURATION,
  };
}

/** Recognizes the synthetic saturation event by its explicit marker field. */
export function isControlPlaneSaturationEvent(event: AnomalyEvent): boolean {
  return event.syntheticPattern === AnomalyPattern.CONTROL_PLANE_SATURATION;
}
