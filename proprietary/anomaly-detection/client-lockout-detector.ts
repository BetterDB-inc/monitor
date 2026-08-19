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
  /**
   * Reading staged by a poll that produced an escalation, applied by
   * `commitClientLockoutLevel`. Holding it back keeps the refusal delta intact
   * for the retry when an emit fails.
   */
  pendingRejected: number | null;
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
  return {
    highUtilStreak: 0,
    level: 'none',
    lastRejected: null,
    lastConnected: null,
    pendingRejected: null,
  };
}

/**
 * Folds one poll into the state and returns a finding only when the risk level
 * ESCALATES (none→warning, none/warning→critical). A steady or improving state
 * stays quiet, so a server parked just over the threshold does not alert every
 * poll.
 *
 * Only a FULL recovery to `none` re-arms alerting. A partial de-escalation keeps
 * the high-water mark, because a client retrying against a full `maxclients`
 * refuses intermittently: critical → (a poll with no new refusals) → critical
 * would otherwise read as a fresh escalation and alert every other poll forever.
 *
 * Known limitation — a SECOND refusal episode at sustained high utilization is
 * not reported. Re-arming needs `level` to reach `none`, which needs both no new
 * refusals AND utilization back under LOCKOUT_UTILIZATION_PCT. A server parked at
 * or above that ceiling settles on `warning`, never `none`, so once it has paged
 * critical, refusals that stop and later resume do not escalate again: the
 * operator sees the first episode and nothing after it until utilization actually
 * recovers. This is the deliberate cost of not alerting every other poll, but a
 * worsening-after-a-lull case does go unreported.
 *
 * CRITICAL needs refusals AND sustained utilization. A refused connection means a
 * client was actually turned away, so it is never dropped — but on its own, during
 * a brief burst that the server absorbs, it is not yet a lockout. It reports
 * WARNING instead, and escalates to CRITICAL if utilization is still pinned at
 * LOCKOUT_UTILIZATION_PCT for LOCKOUT_MIN_STREAK polls. Sustained utilization with
 * no refusals stays WARNING as before.
 *
 * An unreadable ceiling (`maxclients` absent or ≤ 0) is treated as an
 * observation gap: the streak is left untouched rather than reset, and the
 * `rejected_connections` baseline is NOT advanced, so refusals that happen
 * during the gap still surface in the next readable poll's delta instead of
 * being silently consumed.
 *
 * The escalated level is deliberately NOT committed here — the caller commits it
 * with `commitClientLockoutLevel` once the emit has actually succeeded, so a
 * failed emit is retried on the next poll rather than being swallowed by the
 * hysteresis. This mirrors `detectClientSaturation`.
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

  // Baseline advanced only once the sample is actually usable. Advancing it
  // before the guard below would consume a rise in refusals that occurred while
  // the ceiling was unreadable, and the live-refusal signal for that episode
  // would be lost.
  if (connectedClients === null || maxClients === null || maxClients <= 0) {
    return null;
  }
  const nextRejected = rejectedConnections === null ? state.lastRejected : rejectedConnections;

  const previousConnected = state.lastConnected;
  state.lastConnected = connectedClients;

  const utilizationPct = (connectedClients / maxClients) * 100;
  if (utilizationPct >= LOCKOUT_UTILIZATION_PCT) {
    state.highUtilStreak += 1;
  } else {
    state.highUtilStreak = 0;
  }

  // CRITICAL requires BOTH signals: connections are actually being refused AND
  // utilization has sat at the ceiling long enough to rule out a brief spike. A
  // lone refusal during a transient burst is real but not yet a lockout, so it
  // reports WARNING and escalates only if the pressure persists.
  const sustained = state.highUtilStreak >= LOCKOUT_MIN_STREAK;
  const refusing = rejectedDelta > 0;
  let level: LockoutLevel = 'none';
  if (refusing && sustained) {
    level = 'critical';
  } else if (refusing || sustained) {
    level = 'warning';
  }

  const escalated = LEVEL_RANK[level] > LEVEL_RANK[state.level];
  if (level === 'none') {
    state.level = 'none';
  }

  if (!escalated || level === 'none') {
    // No escalation to deliver, so nothing can fail to emit: the baseline is
    // safe to advance immediately.
    state.lastRejected = nextRejected;
    return null;
  }

  // An escalation is being handed to the caller. Advancing the baseline here
  // would consume the refusal delta that drove it, so a failed emit would retry
  // against a counter that no longer shows any new refusals and would silently
  // downgrade to WARNING. Stage it for the commit instead.
  state.pendingRejected = nextRejected;

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

/**
 * Records an escalation as delivered. Called by the emitter AFTER the event has
 * been successfully published, so a failed publish leaves the hysteresis armed
 * and the next poll retries.
 */
export function commitClientLockoutLevel(state: ClientLockoutState, level: LockoutLevel): void {
  state.level = level;
  if (state.pendingRejected === null) {
    return;
  }
  state.lastRejected = state.pendingRejected;
  state.pendingRejected = null;
}
