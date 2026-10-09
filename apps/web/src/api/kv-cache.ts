import { fetchApi } from './client';
import type {
  KvCacheEngine,
  KvCacheEngineCreate,
  KvCacheEngineUpdate,
  KvCacheFootprintSnapshot,
  KvCacheSamplesResponse,
  KvCacheSettings,
  KvCacheSettingsUpdate,
  KvCacheStatus,
} from '@betterdb/shared';

export interface KvCacheSamplesParams {
  from: number;
  to: number;
  engineId?: string;
  model?: string;
}

function samplesQuery(params: KvCacheSamplesParams): string {
  const query = new URLSearchParams({ from: String(params.from), to: String(params.to) });
  if (params.engineId) query.set('engineId', params.engineId);
  if (params.model) query.set('model', params.model);
  return query.toString();
}

export const kvCacheApi = {
  getStatus: (signal?: AbortSignal) => fetchApi<KvCacheStatus>('/kv-cache/status', { signal }),
  refreshFootprint: () =>
    fetchApi<KvCacheFootprintSnapshot | null>('/kv-cache/footprint/refresh', { method: 'POST' }),
  getFootprintHistory: (from: number, to: number, signal?: AbortSignal) =>
    fetchApi<KvCacheFootprintSnapshot[]>(`/kv-cache/footprint/history?from=${from}&to=${to}`, {
      signal,
    }),
  getSamples: (params: KvCacheSamplesParams, signal?: AbortSignal) =>
    fetchApi<KvCacheSamplesResponse>(`/kv-cache/engines/samples?${samplesQuery(params)}`, {
      signal,
    }),
  listEngines: (signal?: AbortSignal) => fetchApi<KvCacheEngine[]>('/kv-cache/engines', { signal }),
  createEngine: (body: KvCacheEngineCreate) =>
    fetchApi<KvCacheEngine>('/kv-cache/engines', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateEngine: (id: string, body: KvCacheEngineUpdate) =>
    fetchApi<KvCacheEngine>(`/kv-cache/engines/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteEngine: (id: string) =>
    fetchApi<void>(`/kv-cache/engines/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getSettings: (signal?: AbortSignal) => fetchApi<KvCacheSettings>('/kv-cache/settings', { signal }),
  updateSettings: (body: KvCacheSettingsUpdate) =>
    fetchApi<KvCacheSettings>('/kv-cache/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
};

export const kvCacheKeys = {
  status: (connectionId: string | null | undefined) => ['kv-cache', 'status', connectionId ?? null],
  history: (connectionId: string | null | undefined, from: number, to: number) => [
    'kv-cache',
    'history',
    connectionId ?? null,
    from,
    to,
  ],
  samples: (connectionId: string | null | undefined, params: object) => [
    'kv-cache',
    'samples',
    connectionId ?? null,
    params,
  ],
  engines: (connectionId: string | null | undefined) => ['kv-cache', 'engines', connectionId ?? null],
  settings: (connectionId: string | null | undefined) => [
    'kv-cache',
    'settings',
    connectionId ?? null,
  ],
};
