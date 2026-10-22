import {
  AnomalyDetectorConfigEntry,
  AnomalyDetectorMetric,
  AnomalyDetectorSettingsResponse,
  AnomalyDetectorUpdateResponse,
  SettingsResponse,
  SettingsUpdateRequest,
} from '@betterdb/shared';
import { fetchApi } from './client';

export const settingsApi = {
  getSettings: () => fetchApi<SettingsResponse>('/settings'),

  updateSettings: (updates: SettingsUpdateRequest) =>
    fetchApi<SettingsResponse>('/settings', {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  resetSettings: () =>
    fetchApi<SettingsResponse>('/settings/reset', {
      method: 'POST',
    }),

  getAnomalyDetectors: () =>
    fetchApi<AnomalyDetectorSettingsResponse>('/settings/anomaly/detectors'),

  updateAnomalyDetectors: (
    update: Partial<Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry>>,
  ) =>
    fetchApi<AnomalyDetectorUpdateResponse>('/settings/anomaly/detectors', {
      method: 'PATCH',
      body: JSON.stringify(update),
    }),

  resetAnomalyDetector: (metric: AnomalyDetectorMetric) =>
    fetchApi<AnomalyDetectorUpdateResponse>(`/settings/anomaly/detectors/${metric}`, {
      method: 'DELETE',
    }),

  resetAllAnomalyDetectors: () =>
    fetchApi<AnomalyDetectorUpdateResponse>('/settings/anomaly/detectors/reset', {
      method: 'POST',
    }),
};
