import type { InferenceLatencyProfile, InferenceLatencyTrend } from '@betterdb/shared';
import { fetchApi } from './client';

export function getInferenceLatencyProfile(
  options: { windowMs?: number; startTime?: number; endTime?: number } = {},
): Promise<InferenceLatencyProfile> {
  const params = new URLSearchParams();
  if (options.windowMs !== undefined) {
    params.set('windowMs', String(options.windowMs));
  }
  if (options.startTime !== undefined) {
    params.set('startTime', String(options.startTime));
  }
  if (options.endTime !== undefined) {
    params.set('endTime', String(options.endTime));
  }
  const qs = params.toString();
  return fetchApi<InferenceLatencyProfile>(
    qs ? `/inference-latency/profile?${qs}` : '/inference-latency/profile',
  );
}

export function getInferenceLatencyTrend(
  bucket: string,
  startTime: number,
  endTime: number,
  bucketMs?: number,
): Promise<InferenceLatencyTrend> {
  const params = new URLSearchParams();
  params.set('bucket', bucket);
  params.set('startTime', String(startTime));
  params.set('endTime', String(endTime));
  if (bucketMs !== undefined) params.set('bucketMs', String(bucketMs));
  return fetchApi<InferenceLatencyTrend>(`/inference-latency/trend?${params.toString()}`);
}
