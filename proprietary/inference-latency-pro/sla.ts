export interface SlaState {
  lastFiredAt: number;
  resolved: boolean;
  lastP99Us: number;
  lastEvaluatedAt: number;
}

export interface EvaluateSlaParams {
  connectionId: string;
  indexName: string;
  currentP99Us: number;
  thresholdUs: number;
  now: number;
  state: Map<string, SlaState>;
}

export interface EvaluateSlaResult {
  fired: boolean;
}

export const SLA_DEBOUNCE_MS = 10 * 60 * 1000;

// A breach whose index produced no FT.SEARCH bucket for this long is treated as
// expired rather than active: with no fresh samples there is nothing to resolve
// it, and reporting it forever would present a stale flag as a live one.
export const SLA_STATE_STALE_MS = 15 * 60 * 1000;

/**
 * Single source of truth for "is this breach live right now" — used by both the
 * Prometheus carry-forward and getSlaStatus so the two surfaces cannot disagree.
 * Re-evaluates the recorded p99 against the CURRENT threshold (so raising the
 * ceiling clears a stale breach and lowering it re-flags a resolved one) and
 * expires bucket-less (quiet/dropped) state after SLA_STATE_STALE_MS. The
 * `resolved` flag stays out of this: it drives webhook re-fire debouncing, not
 * status, and consulting it here would make one direction of threshold change
 * behave differently from the other.
 */
export function isBreachActive(
  prior: SlaState | undefined,
  thresholdUs: number,
  now: number,
): boolean {
  if (prior === undefined) {
    return false;
  }
  if (now - prior.lastEvaluatedAt > SLA_STATE_STALE_MS) {
    return false;
  }
  return prior.lastP99Us > thresholdUs;
}

export function evaluateSla(params: EvaluateSlaParams): EvaluateSlaResult {
  const { connectionId, indexName, currentP99Us, thresholdUs, now, state } = params;
  const key = `${connectionId}|${indexName}`;
  const prior = state.get(key);
  if (prior) {
    prior.lastP99Us = currentP99Us;
    prior.lastEvaluatedAt = now;
  }

  // The configured threshold is the allowed ceiling: a p99 exactly at the
  // threshold is still passing. Only a strictly greater value is a breach.
  if (currentP99Us <= thresholdUs) {
    if (prior) {
      prior.resolved = true;
    }
    return { fired: false };
  }

  if (!prior) {
    state.set(key, {
      lastFiredAt: now,
      resolved: false,
      lastP99Us: currentP99Us,
      lastEvaluatedAt: now,
    });
    return { fired: true };
  }

  if (prior.resolved) {
    prior.lastFiredAt = now;
    prior.resolved = false;
    return { fired: true };
  }

  if (now - prior.lastFiredAt >= SLA_DEBOUNCE_MS) {
    prior.lastFiredAt = now;
    return { fired: true };
  }

  return { fired: false };
}
