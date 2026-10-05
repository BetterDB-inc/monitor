import { fetchApi } from './client';
import type {
  ScalingReadiness,
  ScalingReadinessHistory,
  ScalingReadinessSettings,
  ScalingReadinessSettingsUpdate,
} from '@betterdb/shared';

export const scalingReadinessApi = {
  get: (signal?: AbortSignal) => fetchApi<ScalingReadiness>('/scaling-readiness', { signal }),
  getHistory: (from: number, to: number, signal?: AbortSignal) =>
    fetchApi<ScalingReadinessHistory>(`/scaling-readiness/history?from=${from}&to=${to}`, { signal }),
  getSettings: (signal?: AbortSignal) =>
    fetchApi<ScalingReadinessSettings>('/scaling-readiness/settings', { signal }),
  updateSettings: (update: ScalingReadinessSettingsUpdate) =>
    fetchApi<ScalingReadinessSettings>('/scaling-readiness/settings', {
      method: 'PUT',
      body: JSON.stringify(update),
    }),
};
