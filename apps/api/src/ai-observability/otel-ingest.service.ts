import { Injectable, Inject, Logger } from '@nestjs/common';
import type { StoredOtelSpan } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';

// Minimal OTLP/JSON shapes (ExportTraceServiceRequest). We only read what we need.
interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}
interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: unknown;
  kvlistValue?: unknown;
}
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  status?: { code?: number; message?: string };
}
interface OtlpScopeSpans {
  scope?: { name?: string };
  spans?: OtlpSpan[];
}
interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}
export interface OtlpTraceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

const BETTERDB_SCOPE_PREFIX = '@betterdb/';

/**
 * Sender clock skew tolerated on span start times. `startTimeMs` drives
 * trace sorting and time-window queries, so a far-future sender timestamp
 * would pin hostile spans to the top of every listing; anything beyond this
 * skew is clamped to receive time. (Retention is keyed on the
 * server-stamped `ingestedAt`, never on sender time.)
 */
const MAX_START_TIME_SKEW_MS = 5 * 60 * 1000;

/**
 * Per-span size limits (GHSA-3pjj). The retained-span cap counts spans, not
 * bytes, so without these one span carrying ~1 MB of repetitive attributes
 * (gzips to ~1 KB) was stored whole: ~600 MB/min per IP at the route
 * throttle, exhausting the memory adapter's heap long before the cap and
 * letting SQLite/Postgres grow to cap x 1 MB on disk. With them a stored span
 * is at most a few KB, so the span cap bounds bytes as well.
 *
 * Over-long strings are truncated rather than rejected: real BetterDB spans
 * are a few hundred bytes, so only hostile or unusually verbose third-party
 * root spans are affected, and they keep a clipped but usable record. Ids are
 * the exception — a truncated id could collide with another span — so a span
 * with an over-long id is dropped.
 */
export const OTEL_SPAN_LIMITS = {
  /** traceId / spanId / parentSpanId; OTLP ids are 32 / 16 hex chars. */
  maxIdLength: 64,
  maxNameLength: 256,
  /** Instrumentation scope and service.name. */
  maxScopeOrServiceNameLength: 256,
  maxStatusMessageLength: 1024,
  maxAttributes: 64,
  maxAttributeKeyLength: 128,
  /** A single string value, or the JSON of an array / kvlist value. */
  maxAttributeValueLength: 1024,
  /** Budget for the serialized attributes JSON of one span as a whole. */
  maxAttributesJsonLength: 4096,
} as const;

/** Attribute recording how many attributes the limits dropped (only set when > 0). */
export const DROPPED_ATTRIBUTES_KEY = 'betterdb.dropped_attributes_count';

/** OTLP timestamps are fixed64 nanos; anything outside is not a real time. */
const MAX_UNIX_NANO = 2n ** 64n - 1n;

@Injectable()
export class OtelIngestService {
  private readonly logger = new Logger(OtelIngestService.name);

  constructor(@Inject('STORAGE_CLIENT') private readonly storage: StoragePort) {}

  /**
   * Parse an OTLP/JSON ExportTraceServiceRequest, keep spans from a @betterdb/*
   * instrumentation scope plus root spans (for parent context), and persist them.
   * Returns the number of spans stored.
   */
  async ingest(req: OtlpTraceRequest, now: number): Promise<{ stored: number; received: number }> {
    const toStore: StoredOtelSpan[] = [];
    let received = 0;

    for (const rs of req.resourceSpans ?? []) {
      const serviceName = clipOrNull(
        attrString(rs.resource?.attributes, 'service.name'),
        OTEL_SPAN_LIMITS.maxScopeOrServiceNameLength,
      );
      for (const ss of rs.scopeSpans ?? []) {
        const scopeName = clip(ss.scope?.name, OTEL_SPAN_LIMITS.maxScopeOrServiceNameLength);
        const isBetterdb = scopeName.startsWith(BETTERDB_SCOPE_PREFIX);
        for (const span of ss.spans ?? []) {
          received += 1;
          // Many exporters send an all-zero parent id for root spans; treat empty
          // OR all-zero as root so a non-@betterdb root (e.g. chat.turn) isn't dropped.
          const parentSpanId = isRootParent(span.parentSpanId) ? null : span.parentSpanId!;
          const isRoot = parentSpanId === null;
          // Keep @betterdb/* spans, plus roots (e.g. chat.turn) for context.
          if (!isBetterdb && !isRoot) continue;

          const startNano = toBig(span.startTimeUnixNano);
          const endNano = toBig(span.endTimeUnixNano);
          if (!isValidId(span.traceId) || !isValidId(span.spanId)) continue;
          if (parentSpanId !== null && !isValidId(parentSpanId)) continue;

          toStore.push({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId,
            name: clip(span.name, OTEL_SPAN_LIMITS.maxNameLength),
            scopeName,
            serviceName,
            kind: toInt32(span.kind),
            startTimeUnixNano: startNano.toString(),
            endTimeUnixNano: endNano.toString(),
            startTimeMs: Math.min(Number(startNano / 1_000_000n), now + MAX_START_TIME_SKEW_MS),
            durationNs: toDurationNs(startNano, endNano),
            statusCode: toInt32(span.status?.code),
            statusMessage: clipOrNull(span.status?.message, OTEL_SPAN_LIMITS.maxStatusMessageLength),
            attributes: JSON.stringify(flattenAttrs(span.attributes)),
            ingestedAt: now,
          });
        }
      }
    }

    if (toStore.length === 0) return { stored: 0, received };
    const stored = await this.storage.saveOtelSpans(toStore);
    this.logger.debug(`Ingested ${stored}/${received} spans (kept @betterdb/* + roots)`);
    return { stored, received };
  }
}

/** A span is a root when its parent id is missing, empty, or all-zero. */
function isRootParent(parentSpanId: string | undefined | null): boolean {
  return !parentSpanId || /^0+$/.test(parentSpanId);
}

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= OTEL_SPAN_LIMITS.maxIdLength;
}

/** Truncate to `max` UTF-16 units without splitting a surrogate pair. */
function clip(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  if (v.length <= max) return v;
  const code = v.charCodeAt(max - 1);
  return v.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function clipOrNull(v: unknown, max: number): string | null {
  return typeof v === 'string' ? clip(v, max) : null;
}

function toBig(v: string | number | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  // A fixed64 is at most 20 digits; refuse longer strings before BigInt()
  // parses them, and clamp to the uint64 range so the stored nano strings
  // stay bounded too.
  if (typeof v === 'string' && v.length > 20) return 0n;
  try {
    const n = BigInt(typeof v === 'number' ? Math.trunc(v) : v);
    return n < 0n || n > MAX_UNIX_NANO ? 0n : n;
  } catch {
    return 0n;
  }
}

/**
 * `kind` and `status.code` land in INTEGER columns; a non-integer or
 * out-of-int32 value would fail the whole multi-row INSERT for the request.
 */
function toInt32(v: unknown): number {
  return Number.isInteger(v) && (v as number) >= -(2 ** 31) && (v as number) < 2 ** 31
    ? (v as number)
    : 0;
}

/**
 * Nanos are clamped to uint64, so `end - start` can exceed the BIGINT
 * `duration_ns` column. Clamp to MAX_SAFE_INTEGER (~104 days) rather than
 * 2^63-1: the latter is not representable as a JS number and rounds up to
 * 2^63, which is itself out of BIGINT range.
 */
function toDurationNs(startNano: bigint, endNano: bigint): number {
  if (endNano <= startNano) return 0;
  const ns = endNano - startNano;
  return ns > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(ns);
}

function attrString(attrs: OtlpKeyValue[] | undefined, key: string): string | null {
  const v = (attrs ?? []).find((a) => a.key === key)?.value;
  return v?.stringValue ?? null;
}

/**
 * Flatten OTLP attributes into a plain object, within OTEL_SPAN_LIMITS: at
 * most `maxAttributes` entries, keys and string values truncated, array /
 * kvlist values kept only while their JSON fits (else stored as clipped JSON
 * text), and entries added only while the serialized object stays within
 * `maxAttributesJsonLength`. Entries that do not fit are counted under
 * DROPPED_ATTRIBUTES_KEY so the span detail shows the record is incomplete.
 * DROPPED_ATTRIBUTES_KEY is reserved: a sender-supplied one is ignored, so the
 * count is only ever ours.
 */
function flattenAttrs(attrs: OtlpKeyValue[] | undefined): Record<string, unknown> {
  // Null prototype: a sender key like `__proto__` is then an ordinary own
  // property, instead of swapping the prototype and making `key in out` see
  // inherited names (which would let entries skip the `kept` count).
  const out: Record<string, unknown> = Object.create(null);
  let kept = 0;
  let dropped = 0;
  let jsonLength = 2; // "{}"
  for (const a of attrs ?? []) {
    const raw = attrValue(a.value);
    if (raw === undefined) continue;
    const key = clip(a.key, OTEL_SPAN_LIMITS.maxAttributeKeyLength);
    if (key === DROPPED_ATTRIBUTES_KEY) continue;
    const value = limitAttrValue(raw);
    // Serialized cost of `"key":value,` — measured on the JSON, not the raw
    // string, so escape-heavy values cannot inflate the stored blob past budget.
    const cost = JSON.stringify(key).length + JSON.stringify(value).length + 2;
    if (
      kept >= OTEL_SPAN_LIMITS.maxAttributes ||
      jsonLength + cost > OTEL_SPAN_LIMITS.maxAttributesJsonLength
    ) {
      dropped += 1;
      continue;
    }
    if (!(key in out)) kept += 1;
    out[key] = value;
    jsonLength += cost;
  }
  if (dropped > 0) out[DROPPED_ATTRIBUTES_KEY] = dropped;
  return out;
}

function attrValue(v: OtlpAnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.arrayValue !== undefined || v.kvlistValue !== undefined) return v.arrayValue ?? v.kvlistValue;
  return undefined;
}

function limitAttrValue(v: unknown): unknown {
  const max = OTEL_SPAN_LIMITS.maxAttributeValueLength;
  if (typeof v === 'string') return clip(v, max);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const json = JSON.stringify(v) ?? '';
  return json.length <= max ? v : clip(json, max);
}
