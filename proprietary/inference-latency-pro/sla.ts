export interface SlaState {
  lastFiredAt: number;
  resolved: boolean;
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

export function evaluateSla(params: EvaluateSlaParams): EvaluateSlaResult {
  const { connectionId, indexName, currentP99Us, thresholdUs, now, state } = params;
  const key = `${connectionId}|${indexName}`;
  const prior = state.get(key);

  // The configured threshold is the allowed ceiling: a p99 exactly at the
  // threshold is still passing. Only a strictly greater value is a breach.
  if (currentP99Us <= thresholdUs) {
    if (prior) {
      prior.resolved = true;
    }
    return { fired: false };
  }

  if (!prior) {
    state.set(key, { lastFiredAt: now, resolved: false });
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
