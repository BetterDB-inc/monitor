import type { KvCacheEngineSample, KvCacheSampleCounters } from '@betterdb/shared';

export const METRIC_FIELDS: Readonly<Record<string, keyof KvCacheSampleCounters>> = {
  num_requested_tokens: 'requestedTokens',
  num_hit_tokens: 'hitTokens',
  num_lookup_tokens: 'lookupTokens',
  num_lookup_hits: 'lookupHits',
  num_remote_read_bytes: 'remoteReadBytes',
  num_remote_write_bytes: 'remoteWriteBytes',
  num_remote_read_requests: 'remoteReadRequests',
  num_remote_write_requests: 'remoteWriteRequests',
  remote_ping_errors: 'remotePingErrors',
};

export interface CounterObservation {
  engineId: string;
  connectionId: string;
  modelName: string;
  series: string;
  metric: string;
  value: number;
  cumulative: boolean;
  startMs?: number;
}

export const BUCKET_MS = 60_000;

const emptyCounters = (): KvCacheSampleCounters => ({
  requestedTokens: 0,
  hitTokens: 0,
  lookupTokens: 0,
  lookupHits: 0,
  remoteReadBytes: 0,
  remoteWriteBytes: 0,
  remoteReadRequests: 0,
  remoteWriteRequests: 0,
  remotePingErrors: 0,
});

const bucketStart = (ms: number): number => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

export class CounterDeltaTracker {
  private readonly last = new Map<string, { value: number; startMs?: number }>();
  private readonly buckets = new Map<string, KvCacheEngineSample>();

  observe(observation: CounterObservation, nowMs: number): boolean {
    const field = METRIC_FIELDS[observation.metric];
    if (!field) return false;
    const delta = observation.cumulative
      ? this.cumulativeDelta(observation)
      : observation.value >= 0
        ? observation.value
        : null;
    if (delta === null) return true;
    const timestamp = bucketStart(nowMs);
    const id = `${observation.engineId}|${observation.modelName}|${timestamp}`;
    const bucket = this.buckets.get(id) ?? {
      engineId: observation.engineId,
      connectionId: observation.connectionId,
      modelName: observation.modelName,
      timestamp,
      ...emptyCounters(),
    };
    bucket[field] += delta;
    this.buckets.set(id, bucket);
    return true;
  }

  drain(nowMs: number, includeOpen = false): KvCacheEngineSample[] {
    const open = bucketStart(nowMs);
    const drained: KvCacheEngineSample[] = [];
    for (const [id, bucket] of this.buckets) {
      if (includeOpen || bucket.timestamp < open) {
        drained.push(bucket);
        this.buckets.delete(id);
      }
    }
    return drained.sort((a, b) => a.timestamp - b.timestamp);
  }

  forgetEngine(engineId: string): void {
    for (const id of [...this.last.keys()]) {
      if (id.startsWith(`${engineId}|`)) this.last.delete(id);
    }
    for (const [id, bucket] of this.buckets) {
      if (bucket.engineId === engineId) this.buckets.delete(id);
    }
  }

  private cumulativeDelta(observation: CounterObservation): number | null {
    const id = `${observation.engineId}|${observation.modelName}|${observation.series}|${observation.metric}`;
    const previous = this.last.get(id);
    if (
      previous &&
      observation.value < previous.value &&
      observation.startMs !== undefined &&
      observation.startMs === previous.startMs
    ) {
      return null;
    }
    this.last.set(id, { value: observation.value, startMs: observation.startMs });
    if (!previous) return null;
    return observation.value >= previous.value
      ? observation.value - previous.value
      : observation.value;
  }
}
