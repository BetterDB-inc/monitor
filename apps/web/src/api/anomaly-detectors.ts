import type {
  AnomalyDetectorConfigEntry,
  AnomalyDetectorMetric,
  AnomalyDetectorSettingsResponse,
  AnomalyDetectorUpdateResponse,
} from '@betterdb/shared';
import { fetchApi } from './client';

/** PATCH body: only the metrics and fields being changed. Never contains null. */
export type AnomalyDetectorUpdateRequest = Partial<
  Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry>
>;

export const anomalyDetectorsApi = {
  get: () => fetchApi<AnomalyDetectorSettingsResponse>('/settings/anomaly/detectors'),

  update: (patch: AnomalyDetectorUpdateRequest) =>
    fetchApi<AnomalyDetectorUpdateResponse>('/settings/anomaly/detectors', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  clearMetric: (metric: AnomalyDetectorMetric) =>
    fetchApi<AnomalyDetectorUpdateResponse>(
      `/settings/anomaly/detectors/${encodeURIComponent(metric)}`,
      { method: 'DELETE' },
    ),

  resetAll: () =>
    fetchApi<{ message: string }>('/settings/anomaly/detectors/reset', { method: 'POST' }),
};
