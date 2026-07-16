import { Injectable, Inject, Logger } from '@nestjs/common';
import type { SpanCorrelation, StoredOtelSpan } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type { DatabasePort } from '../common/interfaces/database-port.interface';

/**
 * The differentiator: joins a trace's BetterDB cache/memory spans with the live
 * Valkey-side state (does the key exist now? its TTL, the instance's threshold,
 * the index state) to explain *why* a hit or miss happened — something a pure
 * trace tool cannot do.
 *
 * Caveat: assumes the currently-connected Valkey is the same instance the app
 * used. If not, key lookups will read a different dataset.
 */
@Injectable()
export class TraceCorrelationService {
  private readonly logger = new Logger(TraceCorrelationService.name);

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly registry: ConnectionRegistry,
  ) {}

  async correlateTrace(traceId: string, connectionId?: string): Promise<SpanCorrelation[]> {
    const spans = await this.storage.getOtelTraceSpans(traceId);
    const client = this.registry.get(connectionId);
    const out: SpanCorrelation[] = [];

    for (const span of spans) {
      if (!span.scopeName.startsWith('@betterdb/')) continue;
      const attrs = parseAttrs(span.attributes);
      const cacheKey =
        (typeof attrs['cache.key'] === 'string' && (attrs['cache.key'] as string)) ||
        (typeof attrs['cache.matched_key'] === 'string' && (attrs['cache.matched_key'] as string)) ||
        null;
      const reportedHit = typeof attrs['cache.hit'] === 'boolean' ? (attrs['cache.hit'] as boolean) : null;
      // Instance from the key prefix, else the cache.name attribute — a semantic /
      // memory MISS has no matched key but still reports cache.name, and that miss
      // is exactly the case this correlation is most useful for.
      const instanceName =
        (cacheKey && cacheKey.includes(':') ? cacheKey.slice(0, cacheKey.indexOf(':')) : null) ??
        (typeof attrs['cache.name'] === 'string' ? (attrs['cache.name'] as string) : null);

      // Nothing to correlate without at least a key or an instance name.
      if (!cacheKey && !instanceName) continue;

      try {
        const correlation = await this.correlateSpan(client, span, cacheKey, instanceName, reportedHit);
        out.push(correlation);
      } catch (err) {
        this.logger.debug(
          `Correlation failed for span ${span.spanId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return out;
  }

  private async correlateSpan(
    client: DatabasePort,
    span: StoredOtelSpan,
    cacheKey: string | null,
    instanceName: string | null,
    reportedHit: boolean | null,
  ): Promise<SpanCorrelation> {
    // Only check the key when the span acted on one (hits + exact caches). A
    // semantic/memory miss has no key, so we still surface instance context.
    let keyExistsNow: boolean | null = null;
    let keyTtlSeconds: number | null = null;
    if (cacheKey) {
      keyExistsNow = Number(await client.call('EXISTS', [cacheKey])) === 1;
      keyTtlSeconds = Number(await client.call('TTL', [cacheKey]));
    }

    let threshold: number | null = null;
    let indexState: string | null = null;
    if (instanceName) {
      if (span.scopeName === '@betterdb/semantic-cache') {
        threshold = await readThreshold(client, `${instanceName}:__config`, 'threshold');
        indexState = await readIndexState(client, `${instanceName}:idx`);
      } else if (span.scopeName === '@betterdb/agent-memory') {
        threshold = await readThreshold(client, `${instanceName}:__mem_config`, 'recall.threshold');
        indexState = await readIndexState(client, `${instanceName}:mem:idx`);
      }
    }

    return {
      spanId: span.spanId,
      cacheKey,
      instanceName,
      reportedHit,
      keyExistsNow,
      keyTtlSeconds,
      threshold,
      indexState,
      explanation: explain({ reportedHit, keyExistsNow, keyTtlSeconds, threshold, indexState }),
    };
  }
}

function explain(s: {
  reportedHit: boolean | null;
  keyExistsNow: boolean | null;
  keyTtlSeconds: number | null;
  threshold: number | null;
  indexState: string | null;
}): string {
  const ctx: string[] = [];
  if (s.threshold !== null) ctx.push(`threshold ${s.threshold}`);
  if (s.indexState) ctx.push(`index ${s.indexState}`);
  const ctxNote = ctx.length ? ` (${ctx.join(', ')})` : '';

  // Keyless span — typically a semantic/memory miss with no matched entry.
  if (s.keyExistsNow === null) {
    return s.reportedHit === false
      ? `Miss — nothing matched above the recall/similarity threshold${ctxNote}.`
      : `No cache key on this span${ctxNote}.`;
  }

  const ttlNote =
    s.keyTtlSeconds === -1 ? 'no expiry' : s.keyTtlSeconds === -2 ? 'absent' : `TTL ${s.keyTtlSeconds}s`;
  let base: string;
  if (s.reportedHit === false && s.keyExistsNow) {
    base = `Reported a miss, but the key exists now (${ttlNote}) — it was populated after this request (cold miss; later calls hit).`;
  } else if (s.reportedHit === false && !s.keyExistsNow) {
    base = 'Still uncached — the key is absent now (never stored, or already expired/evicted).';
  } else if (s.reportedHit === true && !s.keyExistsNow) {
    base = 'Hit at request time, but the key has since expired or been evicted.';
  } else if (s.reportedHit === true && s.keyExistsNow) {
    base = `Hit; key still present (${ttlNote}).`;
  } else {
    base = s.keyExistsNow ? `Key present (${ttlNote}).` : 'Key absent now.';
  }
  if (s.indexState && s.indexState !== 'ready') {
    base += ` Index state is "${s.indexState}" — recall may be degraded.`;
  }
  return base;
}

async function readThreshold(
  client: DatabasePort,
  key: string,
  field: string,
): Promise<number | null> {
  try {
    const raw = await client.call('HGET', [key, field]);
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readIndexState(client: DatabasePort, indexName: string): Promise<string | null> {
  try {
    if (!client.getCapabilities().hasVectorSearch) return null;
    const info = await client.getVectorIndexInfo(indexName);
    return info.indexingState ?? null;
  } catch {
    return null;
  }
}

function parseAttrs(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
