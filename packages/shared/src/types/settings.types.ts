import type { InferenceSlaConfig } from './inference-latency';

/**
 * Upper bound for `localRetentionDays` — the PostgreSQL INTEGER column that
 * stores it cannot hold more. Shared by the env schema, the API validation
 * and the settings UI so the limits can't drift.
 */
export const MAX_RETENTION_DAYS = 2_147_483_647;

/**
 * The single validator for retention-days tokens (env var or raw input).
 * Strict whole-token digits: partial prefixes ("30days"), decimals ("1.5")
 * and exponents ("1e2") are rejected to null rather than silently coerced —
 * a malformed value must never activate a deletion window.
 */
export function parseRetentionDaysToken(raw: string | undefined | null): number | null {
  const value = raw?.trim() ?? '';
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_RETENTION_DAYS
    ? parsed
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
