import { fetchApi } from './client';
import type { CacheSimulatorSnapshot } from '@betterdb/shared';

export const cacheSimulatorKeys = {
  snapshot: (connectionId: string | null) => ['cache-simulator', connectionId] as const,
};

export const cacheSimulatorApi = {
  getSnapshot: (refresh: boolean, signal?: AbortSignal) =>
    fetchApi<CacheSimulatorSnapshot>(
      `/cache-simulator/snapshot${refresh ? '?refresh=true' : ''}`,
      { signal },
    ),
};
