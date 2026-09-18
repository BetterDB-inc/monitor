import { timingSafeEqual } from 'node:crypto';

export type MetricsAccess = 'allow' | 'disabled' | 'unauthorized';

export interface MetricsAccessInput {
  enabled: unknown;
  token: string | undefined;
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
  return String(value).trim() !== 'false';
}

export function matchesBearerToken(authorization: string | undefined, token: string): boolean {
  if (!authorization) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const presented = Buffer.from(authorization);
  if (expected.length !== presented.length) {
    return false;
  }
  return timingSafeEqual(expected, presented);
}

export function resolveMetricsAccess(input: MetricsAccessInput): MetricsAccess {
  if (!isMetricsEndpointEnabled(input.enabled)) {
    return 'disabled';
  }
  const token = input.token?.trim();
  if (!token) {
    return input.cloudMode ? 'unauthorized' : 'allow';
  }
  return matchesBearerToken(input.authorization, token) ? 'allow' : 'unauthorized';
}
