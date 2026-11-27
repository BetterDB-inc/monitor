import { fetchApi } from './client';
import type {
  PlacementMode,
  PlacementPolicySaved,
  PlacementSettings,
  PlacementStatus,
} from '@betterdb/shared';

export const placementApi = {
  get: (connectionId: string, signal?: AbortSignal) =>
    fetchApi<PlacementStatus>('/anomaly/placement', {
      signal,
      headers: { 'x-connection-id': connectionId },
    }),
  setMode: (connectionId: string, mode: PlacementMode) =>
    fetchApi<PlacementStatus>('/anomaly/placement/mode', {
      method: 'PUT',
      headers: { 'x-connection-id': connectionId },
      body: JSON.stringify({ mode }),
    }),
  setPolicy: (connectionId: string, policy: PlacementSettings, version: number) =>
    fetchApi<PlacementPolicySaved>('/anomaly/placement/policy', {
      method: 'PUT',
      headers: { 'x-connection-id': connectionId },
      body: JSON.stringify({ policy, version }),
    }),
};
