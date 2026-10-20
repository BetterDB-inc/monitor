import type { StoredOtelSpan } from '@betterdb/shared';

/**
 * Hard cap on retained OTLP spans, enforced by every storage adapter.
 *
 * Time-based retention alone cannot bound the store: within the retention
 * window an unauthenticated sender (POST /v1/traces is public by default)
 * can grow it without limit, and before pruning switched to the
 * server-stamped `ingestedAt` a far-future sender timestamp made spans
 * permanently un-prunable. The cap is the backstop for both: when the store
 * exceeds it, whole traces are evicted oldest-ingested-first until back
 * under the cap.
 *
 * Operators with legitimately heavy tracing can raise it via
 * OTEL_MAX_RETAINED_SPANS (positive integer; invalid values fall back to
 * the default).
 */
export const DEFAULT_OTEL_SPAN_CAP = 50_000;

export function otelSpanCap(): number {
  const raw = process.env.OTEL_MAX_RETAINED_SPANS;
  if (!raw) return DEFAULT_OTEL_SPAN_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_OTEL_SPAN_CAP;
}

/**
 * Low-water mark the store is drained to once it exceeds the cap. Evicting
 * all the way down to this — rather than stopping the moment the count is
 * back at the cap — means the expensive eviction pass (rebuild the per-trace
 * ingest map + sort, or a COUNT + DELETE) runs at most once per
 * ~(cap - low-water) inserts instead of on effectively every save once the
 * store sits at the cap. Under a sustained flood on the public ingest route
 * that is the difference between an O(n log n) pass per request and one every
 * few thousand requests.
 */
export const OTEL_SPAN_CAP_LOW_WATER_RATIO = 0.9;

export function otelSpanLowWaterMark(cap: number = otelSpanCap()): number {
  return Math.max(1, Math.floor(cap * OTEL_SPAN_CAP_LOW_WATER_RATIO));
}

/**
 * How many inserts an adapter lets pass before it re-checks the cap on save.
 * Tied to the low-water headroom so the store grows at most one interval past
 * the cap between checks (~cap + 10% by default), while the check itself stays
 * amortized rather than per-request.
 *
 * The counter is per process, so the real ceiling is cap + one interval + the
 * batch of the request that trips the check — and on multi-replica Postgres
 * each replica keeps its own counter, so the overshoot is per replica. That is
 * an accepted slack, not a hard bound: the point is to keep the store O(cap),
 * not exactly cap. Upserts (re-sends of an existing span) also tick the
 * counter, which only makes the check fire slightly sooner — harmless.
 */
export function otelSpanCapCheckInterval(cap: number = otelSpanCap()): number {
  return Math.max(1, cap - otelSpanLowWaterMark(cap));
}

/**
 * Byte budget for the in-memory span store, on top of the span-count cap.
 *
 * The per-span limits applied at ingest (OTEL_SPAN_LIMITS) bound a stored span
 * to a few KB, so the count cap alone bounds the SQL adapters' disk use. The
 * memory adapter holds everything on the heap, though, and cap x max span size
 * is still several hundred MB — enough to OOM a small container before the
 * count cap is reached. This budget evicts on bytes too: at ordinary span sizes
 * (a few hundred bytes) the count cap binds first, while a flood of max-size
 * spans is held to the budget. OTEL_MAX_RETAINED_SPAN_BYTES tunes it (positive
 * integer; invalid values fall back to the default).
 */
export const DEFAULT_OTEL_SPAN_BYTE_CAP = 128 * 1024 * 1024;

export function otelSpanByteCap(): number {
  const raw = process.env.OTEL_MAX_RETAINED_SPAN_BYTES;
  if (!raw) return DEFAULT_OTEL_SPAN_BYTE_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_OTEL_SPAN_BYTE_CAP;
}

/** Fixed per-span allowance for the numeric fields and object overhead. */
const SPAN_FIXED_BYTES = 128;

/**
 * Approximate heap footprint of a stored span: 2 bytes per UTF-16 unit (the
 * worst case for a V8 string) across its string fields, plus a fixed
 * allowance. An estimate for budgeting, not an exact measurement.
 */
export function approxOtelSpanBytes(s: StoredOtelSpan): number {
  const chars =
    s.traceId.length +
    s.spanId.length +
    (s.parentSpanId?.length ?? 0) +
    s.name.length +
    s.scopeName.length +
    (s.serviceName?.length ?? 0) +
    s.startTimeUnixNano.length +
    s.endTimeUnixNano.length +
    (s.statusMessage?.length ?? 0) +
    s.attributes.length;
  return chars * 2 + SPAN_FIXED_BYTES;
}
