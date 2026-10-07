import { fetchApi } from './client';
import type { ScalingReadiness } from '@betterdb/shared';

export const scalingReadinessApi = {
  get: (signal?: AbortSignal) => fetchApi<ScalingReadiness>('/scaling-readiness', { signal }),
};
