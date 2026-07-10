// Types for OTLP trace ingestion (Phase 2 of AI Cache & Memory observability).
//
// Monitor accepts OTLP/HTTP traces, keeps the spans whose instrumentation scope
// is a BetterDB library (@betterdb/*) plus their root, stores them, and renders
// per-request waterfalls correlated with Valkey-side state. See
// docs/design/ai-cache-memory-observability.md.

/** A single stored span. Times kept as unix-nano strings (nanos exceed JS safe int). */
export interface StoredOtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** Instrumentation scope name, e.g. "@betterdb/agent-cache". */
  scopeName: string;
  serviceName: string | null;
  /** OTLP SpanKind enum (0..5). */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** Derived ms epoch of start, for indexing / ordering / retention. */
  startTimeMs: number;
  /** Duration in nanoseconds (fits a JS safe integer for any realistic span). */
  durationNs: number;
  /** OTLP status code: 0 unset, 1 ok, 2 error. */
  statusCode: number;
  statusMessage: string | null;
  /** Flattened span attributes as JSON (e.g. cache.hit, cache.key, cache.model). */
  attributes: string;
  /** When Monitor received it (ms epoch), for retention. */
  ingestedAt: number;
}

/** Aggregate summary of one trace, for the recent-traces list. */
export interface OtelTraceSummary {
  traceId: string;
  /** Name of the root span (parent-less), e.g. "chat.turn". */
  rootName: string | null;
  serviceName: string | null;
  startTimeMs: number;
  /** Root span duration in ns (or max span end - min start if no single root). */
  durationNs: number;
  spanCount: number;
  /** How many of the spans came from a @betterdb/* scope. */
  betterdbSpanCount: number;
  hasError: boolean;
}

export interface OtelTraceQueryOptions {
  startTime?: number;
  endTime?: number;
  service?: string;
  limit?: number;
}

/**
 * Correlation of one span with the live Valkey-side state of the cache/memory
 * instance it touched — the join that explains *why* a hit/miss happened.
 */
export interface SpanCorrelation {
  spanId: string;
  /** The cache.key / cache.matched_key attribute the span acted on, if any. */
  cacheKey: string | null;
  /** Instance name (prefix) parsed from the key, if resolvable. */
  instanceName: string | null;
  /** Whether the span reported a cache hit (from cache.hit). */
  reportedHit: boolean | null;
  /** Does that key exist in Valkey right now? null = not checked (no key). */
  keyExistsNow: boolean | null;
  /** Current TTL of the key in seconds: >0 ttl, -1 no expiry, -2 missing, null = not checked. */
  keyTtlSeconds: number | null;
  /** Current similarity/recall threshold of the instance, if applicable. */
  threshold: number | null;
  /** FT index indexing state (e.g. "ready"), if the instance has an index. */
  indexState: string | null;
  /** Human-readable explanation joining the span outcome with Valkey state. */
  explanation: string;
}

