import { fetchApi } from './client';
import type {
  MetricForecast,
  MetricForecastSettings,
  MetricForecastSettingsUpdate,
  MetricKind,
} from '@betterdb/shared';

export const metricForecastingApi = {
  getForecast: (metricKind: MetricKind, signal?: AbortSignal) =>
    fetchApi<MetricForecast>(`/metric-forecasting/${metricKind}/forecast`, { signal }),

  getSettings: (metricKind: MetricKind, signal?: AbortSignal) =>
    fetchApi<MetricForecastSettings>(`/metric-forecasting/${metricKind}/settings`, { signal }),

  updateSettings: (metricKind: MetricKind, updates: MetricForecastSettingsUpdate) =>
    fetchApi<MetricForecastSettings>(`/metric-forecasting/${metricKind}/settings`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),
};
