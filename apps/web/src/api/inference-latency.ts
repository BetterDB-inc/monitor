import type { InferenceLatencyProfile } from '@betterdb/shared';
import { fetchApi } from './client';

export function getInferenceLatencyProfile(
  options: { windowMs?: number } = {},
): Promise<InferenceLatencyProfile> {
  const params = new URLSearchParams();
  if (options.windowMs !== undefined) params.set('windowMs', String(options.windowMs));
  const qs = params.toString();
  return fetchApi<InferenceLatencyProfile>(
    qs ? `/inference-latency/profile?${qs}` : '/inference-latency/profile',
  );
}
