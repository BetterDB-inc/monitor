import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { VectorIndexInfo, VectorSearchResult, TextSearchResult, ProfileResult, FieldDistribution } from '../common/types/metrics.types';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { PrometheusService } from '../prometheus/prometheus.service';
import type { VectorIndexSnapshot } from '@betterdb/shared';

@Injectable()
export class VectorSearchService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(VectorSearchService.name);

  private readonly POLL_INTERVAL_MS = 30_000;
  private readonly PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private lastPruneByConnection = new Map<string, number>();
  private lastIndexingFailures = new Map<string, number>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    private prometheusService: PrometheusService,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return this.POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting vector index snapshot polling (interval: ${this.getIntervalMs()}ms)`);
    this.start();
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.lastPruneByConnection.delete(connectionId);
    for (const key of this.lastIndexingFailures.keys()) {
      if (key.startsWith(`${connectionId}|`)) {
        this.lastIndexingFailures.delete(key);
      }
    }
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    if (!ctx.client.getCapabilities().hasVectorSearch) return;

    try {
      const indexes = await ctx.client.getVectorIndexList();
      if (indexes.length === 0) return;

      const settled = await Promise.allSettled(
        indexes.map(name => ctx.client.getVectorIndexInfo(name)),
      );
      const details = settled
        .filter((r): r is PromiseFulfilledResult<VectorIndexInfo> => r.status === 'fulfilled')
        .map(r => r.value);
      if (details.length === 0) return;

      const snapshots: VectorIndexSnapshot[] = details.map(info => {
        const key = `${ctx.connectionId}|${info.name}`;
        const prev = this.lastIndexingFailures.get(key);
        const delta = prev === undefined ? 0 : Math.max(0, info.indexingFailures - prev);
        this.lastIndexingFailures.set(key, info.indexingFailures);

        return {
          id: randomUUID(),
          timestamp: Date.now(),
          connectionId: ctx.connectionId,
          indexName: info.name,
          numDocs: info.numDocs,
          numRecords: info.numRecords,
          numDeletedDocs: info.numDeletedDocs,
          indexingFailures: info.indexingFailures,
          indexingFailuresDelta: delta,
          percentIndexed: info.percentIndexed,
          indexingState: info.indexingState,
          totalIndexingTime: info.totalIndexingTime,
          memorySizeMb: info.memorySizeMb,
        };
      });

      await this.storage.saveVectorIndexSnapshots(snapshots, ctx.connectionId);

      this.prometheusService.updateVectorIndexMetrics(
        ctx.connectionId,
        snapshots.map(s => ({
          indexName: s.indexName,
          numDocs: s.numDocs,
          memorySizeMb: s.memorySizeMb,
          indexingFailures: s.indexingFailures,
          percentIndexed: s.percentIndexed,
        })),
      );

      const now = Date.now();
      const lastPrune = this.lastPruneByConnection.get(ctx.connectionId) ?? 0;
      if (now - lastPrune > this.PRUNE_INTERVAL_MS) {
        this.lastPruneByConnection.set(ctx.connectionId, now);
        await this.storage.pruneOldVectorIndexSnapshots(
          now - 7 * 24 * 60 * 60 * 1000,
          ctx.connectionId,
        );
      }
    } catch (error) {
      this.logger.error(`Error capturing vector index snapshots for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getSnapshots(connectionId: string | undefined, indexName: string, hours: number = 24): Promise<VectorIndexSnapshot[]> {
    const resolvedId = connectionId ?? this.connectionRegistry.getDefaultId() ?? undefined;
    const allSnapshots = await this.storage.getVectorIndexSnapshots({
      connectionId: resolvedId,
      indexName,
      startTime: Date.now() - hours * 60 * 60 * 1000,
    });
    // Downsample to ~200 points for display — evenly spaced across the window
    if (allSnapshots.length <= 200) return allSnapshots;
    const step = allSnapshots.length / 200;
    const sampled: VectorIndexSnapshot[] = [];
    for (let i = 0; i < 200; i++) {
      sampled.push(allSnapshots[Math.round(i * step)]);
    }
    return sampled;
  }

  private getCheckedClient(connectionId?: string): ReturnType<ConnectionRegistry['get']> {
    const client = this.connectionRegistry.get(connectionId);
    if (!client.getCapabilities().hasVectorSearch) {
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
    }
    return client;
  }

  async getIndexList(connectionId?: string): Promise<string[]> {
    return this.getCheckedClient(connectionId).getVectorIndexList();
  }

  async getIndexInfo(connectionId: string | undefined, indexName: string): Promise<VectorIndexInfo> {
    return this.getCheckedClient(connectionId).getVectorIndexInfo(indexName);
  }

  async search(
    connectionId: string | undefined,
    indexName: string,
    sourceKey: string,
    vectorField: string,
    k: number,
    filter?: string,
  ): Promise<{ results: VectorSearchResult[]; query: { sourceKey: string; vectorField: string; k: number; filter?: string } }> {
    const client = this.getCheckedClient(connectionId);
    const clampedK = Math.min(Math.max(k, 1), 50);

    const vectorBytes = await client.getHashFieldBuffer(sourceKey, vectorField);
    if (vectorBytes === null) {
      throw new Error(`Key '${sourceKey}' or field '${vectorField}' not found`);
    }

    const results = await client.vectorSearch(indexName, vectorField, vectorBytes, clampedK, filter);
    return { results, query: { sourceKey, vectorField, k: clampedK, filter } };
  }

  async sampleKeys(
    connectionId: string | undefined,
    indexName: string,
    cursor: string,
    limit: number,
  ): Promise<{ keys: Array<{ key: string; fields: Record<string, string> }>; cursor: string }> {
    const client = this.getCheckedClient(connectionId);
    const indexInfo = await client.getVectorIndexInfo(indexName);
    const prefixes = indexInfo.indexDefinition?.prefixes ?? [];

    const vectorFieldNames = new Set(
      indexInfo.fields.filter(f => f.type === 'VECTOR').map(f => f.name),
    );

    let rawClient: ReturnType<typeof client.getClient>;
    try {
      rawClient = client.getClient();
    } catch {
      throw new Error('Key browsing is not supported on this connection type');
    }
    const cappedLimit = Math.min(Math.max(limit, 1), 200);

    // Composite cursor: "prefixIdx:scanCursor" for multi-prefix, plain cursor otherwise
    let prefixIdx = 0;
    let scanCursor = cursor;
    if (prefixes.length > 1 && cursor !== '0' && cursor.includes(':')) {
      const colonPos = cursor.indexOf(':');
      prefixIdx = parseInt(cursor.substring(0, colonPos), 10) || 0;
      scanCursor = cursor.substring(colonPos + 1) || '0';
    }

    let allKeys: string[] = [];
    let outPrefixIdx = prefixIdx;
    let outScanCursor = '0';

    if (prefixes.length === 0) {
      const [nc, keys] = await rawClient.scan(scanCursor, 'COUNT', cappedLimit);
      allKeys = (keys as string[]).slice(0, cappedLimit);
      outScanCursor = String(nc);
    } else {
      let currentCursor = scanCursor;
      for (let i = prefixIdx; i < prefixes.length; i++) {
        if (allKeys.length >= cappedLimit) {
          outPrefixIdx = i;
          outScanCursor = currentCursor;
          break;
        }
        const remaining = cappedLimit - allKeys.length;
        const useCursor = i === prefixIdx ? currentCursor : '0';
        const [nc, keys] = await rawClient.scan(
          useCursor, 'MATCH', `${prefixes[i]}*`, 'COUNT', remaining,
        );
        allKeys.push(...(keys as string[]).slice(0, remaining));

        const nextCursor = String(nc);
        if (nextCursor === '0') {
          outPrefixIdx = i + 1;
          outScanCursor = '0';
          currentCursor = '0';
        } else {
          outPrefixIdx = i;
          outScanCursor = nextCursor;
          break;
        }
      }
    }

    const limitedKeys = allKeys.slice(0, cappedLimit);

    // Build return cursor
    let returnCursor: string;
    if (prefixes.length <= 1) {
      returnCursor = outScanCursor;
    } else if (outPrefixIdx >= prefixes.length && outScanCursor === '0') {
      returnCursor = '0';
    } else {
      returnCursor = `${outPrefixIdx}:${outScanCursor}`;
    }

    if (limitedKeys.length === 0) {
      return { keys: [], cursor: returnCursor };
    }

    const pipeline = rawClient.pipeline();
    for (const key of limitedKeys) {
      pipeline.hgetall(key);
    }
    const pipelineResults = await pipeline.exec();

    const keys: Array<{ key: string; fields: Record<string, string> }> = [];
    for (let i = 0; i < limitedKeys.length; i++) {
      const [err, rawFields] = pipelineResults![i];
      if (err || !rawFields || typeof rawFields !== 'object' || Object.keys(rawFields as object).length === 0) {
        continue; // skip non-hash keys or empty results
      }
      const fields: Record<string, string> = {};
      for (const [fieldName, fieldValue] of Object.entries(rawFields as Record<string, string>)) {
        if (!vectorFieldNames.has(fieldName) && typeof fieldValue === 'string' && fieldValue.length < 2000) {
          fields[fieldName] = fieldValue;
        }
      }
      keys.push({ key: limitedKeys[i], fields });
    }

    return { keys, cursor: returnCursor };
  }

  async textSearch(connectionId: string | undefined, indexName: string, query: string, offset?: number, limit?: number): Promise<TextSearchResult> {
    return this.getCheckedClient(connectionId).textSearch(indexName, query, offset, limit);
  }

  async getTagValues(connectionId: string | undefined, indexName: string, fieldName: string): Promise<string[]> {
    return this.getCheckedClient(connectionId).getTagValues(indexName, fieldName);
  }

  async getSearchConfig(connectionId?: string): Promise<Record<string, string>> {
    return this.getCheckedClient(connectionId).getSearchConfig();
  }

  async profileSearch(connectionId: string | undefined, indexName: string, query: string, limited?: boolean): Promise<ProfileResult> {
    return this.getCheckedClient(connectionId).profileSearch(indexName, query, limited);
  }

  async getFieldDistribution(connectionId: string | undefined, indexName: string, fieldName: string, fieldType: string): Promise<FieldDistribution> {
    const docs = await this.sampleDocuments(connectionId, indexName);

    if (fieldType === 'TAG') {
      return this.getTagDistribution(docs, fieldName);
    }
    if (fieldType === 'NUMERIC') {
      return this.getNumericDistribution(docs, fieldName);
    }
    return this.getTextDistribution(docs, fieldName);
  }

  /** Try FT.SEARCH * first; fall back to SCAN-based sampling (Valkey Search doesn't support wildcard text queries) */
  private async sampleDocuments(connectionId: string | undefined, indexName: string): Promise<Record<string, string>[]> {
    const client = this.getCheckedClient(connectionId);
    try {
      const result = await client.textSearch(indexName, '*', 0, 100);
      return result.results.map(r => r.fields);
    } catch {
      // FT.SEARCH * not supported (Valkey Search) — fall back to SCAN + HGETALL
      const sampled = await this.sampleKeys(connectionId, indexName, '0', 100);
      return sampled.keys.map(k => k.fields);
    }
  }

  private getTagDistribution(docs: Record<string, string>[], fieldName: string): FieldDistribution {
    const freq = new Map<string, number>();
    for (const fields of docs) {
      const v = fields[fieldName];
      if (v) {
        for (const tag of v.split(',')) {
          const trimmed = tag.trim();
          if (trimmed) freq.set(trimmed, (freq.get(trimmed) ?? 0) + 1);
        }
      }
    }
    const distribution = [...freq.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
    return { fieldName, type: 'TAG', distribution };
  }

  private getNumericDistribution(docs: Record<string, string>[], fieldName: string): FieldDistribution {
    const values = docs
      .map(f => parseFloat(f[fieldName]))
      .filter(v => !isNaN(v));
    if (values.length === 0) {
      return { fieldName, type: 'NUMERIC', distribution: [], stats: { min: 0, max: 0, avg: 0, count: 0 } };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    return { fieldName, type: 'NUMERIC', distribution: [], stats: { min, max, avg, count: values.length } };
  }

  private getTextDistribution(docs: Record<string, string>[], fieldName: string): FieldDistribution {
    const freq = new Map<string, number>();
    for (const fields of docs) {
      const v = fields[fieldName];
      if (v) {
        const truncated = v.length > 60 ? v.slice(0, 57) + '...' : v;
        freq.set(truncated, (freq.get(truncated) ?? 0) + 1);
      }
    }
    const distribution = [...freq.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
    return { fieldName, type: 'TEXT', distribution };
  }
}
