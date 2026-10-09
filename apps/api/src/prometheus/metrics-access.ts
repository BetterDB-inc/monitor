import { createHash, timingSafeEqual } from 'node:crypto';

export type MetricsAccess = 'allow' | 'disabled' | 'unauthorized';

export interface MetricsAccessInput {
  enabled: unknown;
  token: string | undefined;
  // Secondary token intended for publication (e.g. the hosted live demo).
  // Either token grants access, so the published one can be rotated without
  // touching the scrape configs that use the primary.
  publicToken?: string | undefined;
  cloudMode: boolean;
  authorization: string | undefined;
}

export function isMetricsEndpointEnabled(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return String(value).trim().toLowerCase() !== 'false';
}

export function matchesBearerToken(authorization: string | undefined, token: string): boolean {
  if (!authorization) {
    return false;
  }
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const presented = createHash('sha256').update(authorization).digest();
  return timingSafeEqual(expected, presented);
}

export function resolveMetricsAccess(input: MetricsAccessInput): MetricsAccess {
  if (!isMetricsEndpointEnabled(input.enabled)) {
    return 'disabled';
  }
  const tokens = [input.token, input.publicToken]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  if (tokens.length === 0) {
    return input.cloudMode ? 'unauthorized' : 'allow';
  }
  return tokens.some((token) => matchesBearerToken(input.authorization, token))
    ? 'allow'
    : 'unauthorized';
}
