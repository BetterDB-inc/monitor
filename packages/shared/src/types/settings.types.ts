export interface AppSettings {
  id: number;

  auditPollIntervalMs: number;

  clientAnalyticsPollIntervalMs: number;

  anomalyPollIntervalMs: number;
  anomalyCacheTtlMs: number;
  anomalyPrometheusIntervalMs: number;

  throughputForecastingEnabled: boolean;
  throughputForecastingDefaultRollingWindowMs: number;
  throughputForecastingDefaultAlertThresholdMs: number;

  updatedAt: number;
  createdAt: number;
}

export type SettingsUpdateRequest = Partial<Omit<AppSettings, 'id' | 'createdAt' | 'updatedAt'>>;

export interface SettingsResponse {
  settings: AppSettings;
  source: 'database' | 'environment' | 'defaults';
  requiresRestart: boolean;
}
