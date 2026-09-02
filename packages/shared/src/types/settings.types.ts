import type { InferenceSlaConfig } from './inference-latency';

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
