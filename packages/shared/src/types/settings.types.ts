import type { InferenceSlaConfig } from './inference-latency';

/**
 * Upper bound for `localRetentionDays` — 100 years. Shared by the env schema,
 * the API validation and the settings UI so the limits can't drift. The bound
 * must stay far below ~100,000,000 (the JS Date range in days) or a stored
 * value makes `new Date(now - days * MS_PER_DAY)` throw; it is also
 * comfortably inside the PostgreSQL INTEGER column that stores it.
 */
export const MAX_RETENTION_DAYS = 36_500;

/**
 * The single validator for retention-days tokens (env var or raw input).
 * Strict whole-token digits: partial prefixes ("30days"), decimals ("1.5")
 * and exponents ("1e2") are rejected to null rather than silently coerced —
 * a malformed value must never activate a deletion window.
 */
export function parseRetentionDaysToken(raw: string | undefined | null): number | null {
  const value = raw?.trim() ?? '';
  if (!/^\d+$/.test(value)) return null;
  return normalizeRetentionDays(Number(value));
}

/**
 * The single numeric validator for a retention window: a whole number of
 * days in [1, MAX_RETENTION_DAYS], anything else is null (treated as unset).
 * Every layer — env parsing, API validation, the UI, and the policy reading
 * a persisted value — must funnel through this so they can never disagree.
 */
export function normalizeRetentionDays(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_RETENTION_DAYS
    ? value
    : null;
}

export interface AppSettings {
  id: number;

  auditPollIntervalMs: number;

  clientAnalyticsPollIntervalMs: number;

  anomalyPollIntervalMs: number;
  anomalyCacheTtlMs: number;
  anomalyPrometheusIntervalMs: number;

  metricForecastingEnabled: boolean;
  metricForecastingDefaultRollingWindowMs: number;
  metricForecastingDefaultAlertThresholdMs: number;

  inferenceSlaConfig: InferenceSlaConfig;

  /**
   * Self-hosted only: age (in days) beyond which stored monitoring history is
   * deleted by the daily local retention sweep. null disables the sweep and
   * keeps history indefinitely. Ignored in cloud mode, where the tier-based
   * retention sweep owns the policy.
   */
  localRetentionDays: number | null;

  updatedAt: number;
  createdAt: number;
}

export type SettingsUpdateRequest = Partial<Omit<AppSettings, 'id' | 'createdAt' | 'updatedAt'>>;

export interface SettingsResponse {
  settings: AppSettings;
  source: 'database' | 'environment' | 'defaults';
  requiresRestart: boolean;
}
