import { fetchApi } from './client';
import type { AiInstance, StoredAiCacheSample } from '@betterdb/shared';

export interface AiInstanceWithSample {
  instance: AiInstance;
  latest: StoredAiCacheSample | null;
}

export const aiObservabilityApi = {
  /** Discovered AI cache/memory instances on the current connection + their latest sample. */
  getInstances: () =>
    fetchApi<{ instances: AiInstanceWithSample[] }>('/ai/instances').then((r) => r.instances),

  /** Time-series history for one instance. */
  getHistory: (field: string, hours = 24) =>
    fetchApi<{ samples: StoredAiCacheSample[] }>(
      `/ai/instances/${encodeURIComponent(field)}/history?hours=${hours}`,
    ).then((r) => r.samples),
};
