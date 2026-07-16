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
      const serviceName = attrString(rs.resource?.attributes, 'service.name');
      for (const ss of rs.scopeSpans ?? []) {
        const scopeName = ss.scope?.name ?? '';
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
          if (!span.traceId || !span.spanId) continue;

          toStore.push({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId,
            name: span.name ?? '',
            scopeName,
            serviceName,
            kind: typeof span.kind === 'number' ? span.kind : 0,
            startTimeUnixNano: startNano.toString(),
            endTimeUnixNano: endNano.toString(),
            startTimeMs: Number(startNano / 1_000_000n),
            durationNs: endNano > startNano ? Number(endNano - startNano) : 0,
            statusCode: span.status?.code ?? 0,
            statusMessage: span.status?.message ?? null,
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

function toBig(v: string | number | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  try {
    return BigInt(typeof v === 'number' ? Math.trunc(v) : v);
  } catch {
    return 0n;
  }
}

function attrString(attrs: OtlpKeyValue[] | undefined, key: string): string | null {
  const v = (attrs ?? []).find((a) => a.key === key)?.value;
  return v?.stringValue ?? null;
}

function flattenAttrs(attrs: OtlpKeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) {
    const v = a.value;
    if (!v) continue;
    if (v.stringValue !== undefined) out[a.key] = v.stringValue;
    else if (v.boolValue !== undefined) out[a.key] = v.boolValue;
    else if (v.doubleValue !== undefined) out[a.key] = v.doubleValue;
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue);
    else if (v.arrayValue !== undefined || v.kvlistValue !== undefined)
      out[a.key] = v.arrayValue ?? v.kvlistValue;
  }
  return out;
}
