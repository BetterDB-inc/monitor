import { fetchApi } from './client';
import type { CacheSimulatorSnapshot } from '@betterdb/shared';

export const cacheSimulatorKeys = {
  snapshot: (connectionId: string | null) => ['cache-simulator', connectionId] as const,
};

export const cacheSimulatorApi = {
  getSnapshot: (connectionId: string | null, refresh: boolean, signal?: AbortSignal) =>
    fetchApi<CacheSimulatorSnapshot>(
      `/cache-simulator/snapshot${refresh ? '?refresh=true' : ''}`,
      { signal, ...(connectionId ? { headers: { 'x-connection-id': connectionId } } : {}) },
    ),
};
