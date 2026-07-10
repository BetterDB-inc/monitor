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

      // Only correlate spans that acted on a concrete key.
      if (!cacheKey) continue;

      try {
        const correlation = await this.correlateSpan(client, span, cacheKey, reportedHit);
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
    cacheKey: string,
    reportedHit: boolean | null,
  ): Promise<SpanCorrelation> {
    const instanceName = cacheKey.includes(':') ? cacheKey.slice(0, cacheKey.indexOf(':')) : null;

    const exists = Number(await client.call('EXISTS', [cacheKey])) === 1;
    const ttl = Number(await client.call('TTL', [cacheKey]));

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
      keyExistsNow: exists,
      keyTtlSeconds: ttl,
      threshold,
      indexState,
      explanation: explain({ reportedHit, exists, ttl, threshold, indexState }),
    };
  }
}

function explain(s: {
  reportedHit: boolean | null;
  exists: boolean;
  ttl: number;
  threshold: number | null;
  indexState: string | null;
}): string {
  const ttlNote =
    s.ttl === -1 ? 'no expiry' : s.ttl === -2 ? 'absent' : `TTL ${s.ttl}s`;
  let base: string;
  if (s.reportedHit === false && s.exists) {
    base = `Reported a miss, but the key exists now (${ttlNote}) — it was populated after this request (cold miss; later calls hit).`;
  } else if (s.reportedHit === false && !s.exists) {
    base = 'Still uncached — the key is absent now (never stored, or already expired/evicted).';
  } else if (s.reportedHit === true && !s.exists) {
    base = 'Hit at request time, but the key has since expired or been evicted.';
  } else if (s.reportedHit === true && s.exists) {
    base = `Hit; key still present (${ttlNote}).`;
  } else {
    base = s.exists ? `Key present (${ttlNote}).` : 'Key absent now.';
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
