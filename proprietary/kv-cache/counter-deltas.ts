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
export const BASELINE_IDLE_MS = 60 * 60_000;

const KEYED_LABELS = new Set(['model_name', 'worker_id', 'role']);

export function labelSeries(labels: Record<string, string>): string {
  const base = `${labels.worker_id ?? ''}|${labels.role ?? ''}`;
  const extras = Object.entries(labels)
    .filter(([key]) => !KEYED_LABELS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return extras.length === 0 ? base : `${base}|${JSON.stringify(extras)}`;
}

const COUNTER_FIELDS = Object.values(METRIC_FIELDS);

const emptyCounters = (): KvCacheSampleCounters =>
  Object.fromEntries(COUNTER_FIELDS.map((field) => [field, 0])) as unknown as KvCacheSampleCounters;

export function addCounters(target: KvCacheSampleCounters, source: KvCacheSampleCounters): void {
  for (const field of COUNTER_FIELDS) target[field] += source[field];
}

const bucketStart = (ms: number): number => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

export class CounterDeltaTracker {
  private readonly last = new Map<string, { value: number; startMs?: number; seenMs: number }>();
  private readonly buckets = new Map<string, KvCacheEngineSample>();
  private drainedBefore = Number.NEGATIVE_INFINITY;

  observe(observation: CounterObservation, nowMs: number): boolean {
    if (!Object.hasOwn(METRIC_FIELDS, observation.metric)) return false;
    if (!Number.isFinite(observation.value)) return false;
    const field = METRIC_FIELDS[observation.metric];
    const delta = observation.cumulative
      ? this.cumulativeDelta(observation, nowMs)
      : observation.value >= 0
        ? observation.value
        : null;
    if (delta === null) return true;
    const timestamp = Math.max(bucketStart(nowMs), this.drainedBefore);
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
    for (const [id, baseline] of this.last) {
      if (nowMs - baseline.seenMs > BASELINE_IDLE_MS) this.last.delete(id);
    }
    this.drainedBefore = Math.max(this.drainedBefore, includeOpen ? open + BUCKET_MS : open);
    const drained: KvCacheEngineSample[] = [];
    for (const [id, bucket] of this.buckets) {
      if (includeOpen || bucket.timestamp < open) {
        drained.push(bucket);
        this.buckets.delete(id);
      }
    }
    return drained.sort((a, b) => a.timestamp - b.timestamp);
  }

  baselineCount(): number {
    return this.last.size;
  }

  forgetEngine(engineId: string): void {
    this.forgetBaselines(engineId);
    for (const [id, bucket] of this.buckets) {
      if (bucket.engineId === engineId) this.buckets.delete(id);
    }
  }

  forgetBaselines(engineId: string): void {
    for (const id of [...this.last.keys()]) {
      if (id.startsWith(`${engineId}|`)) this.last.delete(id);
    }
  }

  private cumulativeDelta(observation: CounterObservation, seenMs: number): number | null {
    const id = `${observation.engineId}|${observation.modelName}|${observation.series}|${observation.metric}`;
    const previous = this.last.get(id);
    const startMs = observation.startMs ?? previous?.startMs;
    if (!previous) {
      this.last.set(id, { value: observation.value, startMs, seenMs });
      return null;
    }
    const order =
      observation.startMs !== undefined && previous.startMs !== undefined
        ? Math.sign(observation.startMs - previous.startMs)
        : null;
    if (order !== null && order < 0) return null;
    if (order !== null && order > 0) {
      this.last.set(id, { value: observation.value, startMs, seenMs });
      return null;
    }
    if (order === 0 && observation.value < previous.value) return null;
    this.last.set(id, { value: observation.value, startMs, seenMs });
    return observation.value < previous.value ? observation.value : observation.value - previous.value;
  }
}
