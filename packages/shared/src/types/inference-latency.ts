export type InferenceLatencySource = 'commandlog' | 'slowlog';

export interface IndexingEvent {
  kind: 'latency_degraded_during_indexing';
  bucket: string;
  since: number;
}

export interface InferenceLatencyBucket {
  bucket: string;
  p50: number;
  p95: number;
  p99: number;
  count: number;
  unhealthy: boolean;
  namedEvents: IndexingEvent[];
}

export interface InferenceLatencyProfile {
  connectionId: string;
  windowMs: number;
  source: InferenceLatencySource;
  thresholdDirective: string;
  thresholdUs: number;
  buckets: InferenceLatencyBucket[];
  generatedAt: number;
}

export interface InferenceSlaEntry {
  p99ThresholdUs: number;
  enabled: boolean;
}

export type InferenceSlaConfig = Record<string, InferenceSlaEntry>;

export const FT_SEARCH_HEALTHY_P50_THRESHOLD_US = 10_000;

export interface InferenceLatencyTrendPoint {
  capturedAt: number;
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

export interface InferenceLatencyTrend {
  connectionId: string;
  bucket: string;
  startTime: number;
  endTime: number;
  bucketMs: number;
  source: InferenceLatencySource;
  points: InferenceLatencyTrendPoint[];
}

/**
 * Hook the OSS InferenceLatencyService calls after each poll tick.
 * Implemented by proprietary/inference-latency-pro/inference-latency-pro.service.ts.
 * Owns SLA evaluation, debounce state, and inference_sla_breach gauge updates.
 */
export interface InferenceProfileTickContext {
  connectionId: string;
  host: string;
  port: number;
}

export interface IInferenceLatencyProService {
  onProfileTick(
    ctx: InferenceProfileTickContext,
    profile: InferenceLatencyProfile,
  ): Promise<void>;
  onConnectionRemoved(connectionId: string): void;
}

export const INFERENCE_LATENCY_PRO_SERVICE = 'INFERENCE_LATENCY_PRO_SERVICE';
