/**
 * Connection-exhaustion / admin-lockout advisory (valkey-io/valkey#3944).
 *
 * When `connected_clients` nears the `maxclients` ceiling, every new connection
 * is refused — including the operator's own admin and control-plane traffic. The
 * instance becomes hard to inspect or rescue at exactly the moment you need to,
 * which is what upstream #3944 is about ("Unable to operate when max number of
 * clients reached"). Upstream's answer is a reserved/priority connection quota
 * (`priority-net-sources`, `priority-maxclients`, `prioritize-unix-sockets`);
 * that shrinks the blast radius but does not remove the hazard of running near
 * the ceiling, and will not be present on the many already-deployed versions.
 *
 * This is deliberately NOT the existing `CLIENT_SATURATION` metric, which fires
 * off a single sample crossing 80%/95% and reports raw saturation. Two things
 * differ here:
 *
 *  - A **sustained** streak is required, so a burst of short-lived connections
 *    that clears on the next poll never fires.
 *  - Utilization is **tied to actual refusals**: a rising `rejected_connections`
 *    counter means connections are being turned away right now, which is the
 *    lockout itself rather than the approach to it.
 *
 * The result is one finding that says "you are about to lose, or have already
 * lost, your own way in" — with the remedy — instead of two unrelated numbers.
 */

/** Utilization (percent of `maxclients`) at which headroom counts as nearly gone. */
export const LOCKOUT_UTILIZATION_PCT = 85;

/**
 * Consecutive polls above the utilization threshold before a WARNING fires.
 * Conservative on purpose: workloads that intentionally run a large, stable
 * connection pool sit high without ever being at risk, and a brief burst is not
 * a lockout.
 */
export const LOCKOUT_MIN_STREAK = 3;

export type LockoutLevel = 'none' | 'warning' | 'critical';

const LEVEL_RANK: Record<LockoutLevel, number> = { none: 0, warning: 1, critical: 2 };

export interface ClientLockoutState {
  /** Consecutive polls at or above the utilization threshold. */
  highUtilStreak: number;
  /** Last emitted level, for escalation-only hysteresis. */
  level: LockoutLevel;
  /** Previous poll's lifetime `rejected_connections`, for the per-poll delta. */
  lastRejected: number | null;
  /** Previous poll's `connected_clients`, to tell a climb from a plateau. */
  lastConnected: number | null;
}

export interface ClientLockoutInput {
  connectedClients: number | null;
  /** `maxclients`; 0, negative, or null means the ceiling is unreadable. */
  maxClients: number | null;
  /** Lifetime `rejected_connections` counter. */
  rejectedConnections: number | null;
  blockedClients: number | null;
}

export interface ClientLockoutFinding {
  level: Exclude<LockoutLevel, 'none'>;
  connectedClients: number;
  maxClients: number;
  utilizationPct: number;
  /** New refusals since the previous poll. */
  rejectedDelta: number;
  blockedClients: number | null;
  /** Whether `connected_clients` grew since the previous poll. */
  rising: boolean;
  streak: number;
}

export function createClientLockoutState(): ClientLockoutState {
  return { highUtilStreak: 0, level: 'none', lastRejected: null, lastConnected: null };
}

/**
 * Folds one poll into the state and returns a finding only when the risk level
 * ESCALATES (none→warning, none/warning→critical). A steady or improving state
 * stays quiet and re-arms alerting once it falls back to `none`, so a server
 * parked just over the threshold does not alert every poll.
 *
 * An unreadable ceiling (`maxclients` absent or ≤ 0) is treated as an
 * observation gap: the streak is left untouched rather than reset, so a missing
 * sample mid-climb cannot silently disarm the warning.
 */
export function evaluateClientLockout(
  state: ClientLockoutState,
  input: ClientLockoutInput,
): ClientLockoutFinding | null {
  const { connectedClients, maxClients, rejectedConnections, blockedClients } = input;

  // max(0, …) absorbs a counter reset (server restart puts the counter back to 0).
  const rejectedDelta =
    rejectedConnections === null || state.lastRejected === null
      ? 0
      : Math.max(0, rejectedConnections - state.lastRejected);
  if (rejectedConnections !== null) {
    state.lastRejected = rejectedConnections;
  }

  if (connectedClients === null || maxClients === null || maxClients <= 0) {
    return null;
  }

  const previousConnected = state.lastConnected;
  state.lastConnected = connectedClients;

  const utilizationPct = (connectedClients / maxClients) * 100;
  if (utilizationPct >= LOCKOUT_UTILIZATION_PCT) {
    state.highUtilStreak += 1;
  } else {
    state.highUtilStreak = 0;
  }

  const sustained = state.highUtilStreak >= LOCKOUT_MIN_STREAK;
  let level: LockoutLevel = 'none';
  if (rejectedDelta > 0) {
    level = 'critical';
  } else if (sustained) {
    level = 'warning';
  }

  const escalated = LEVEL_RANK[level] > LEVEL_RANK[state.level];
  state.level = level;

  if (!escalated || level === 'none') {
    return null;
  }

  return {
    level,
    connectedClients,
    maxClients,
    utilizationPct,
    rejectedDelta,
    blockedClients,
    rising: previousConnected !== null && connectedClients > previousConnected,
    streak: state.highUtilStreak,
  };
}
