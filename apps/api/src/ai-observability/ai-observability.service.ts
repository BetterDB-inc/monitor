import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import type {
  AiInstance,
  StoredAiCacheSample,
  OtelTraceSummary,
  StoredOtelSpan,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import { DiscoveryReaderService } from './discovery-reader.service';

/** An instance plus its most recent polled sample (for the API). */
export interface AiInstanceWithSample {
  instance: AiInstance;
  latest: StoredAiCacheSample | null;
}

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const SIMILARITY_WINDOW_SAMPLE = 200;

@Injectable()
export class AiObservabilityService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(AiObservabilityService.name);
  private readonly pollIntervalMs: number;

  // Self-hosted deployments have no cloud retention cron, so the poller trims its
  // own history locally at the community window. In CLOUD_MODE the tier-based
  // data-retention sweep owns retention (and keeps longer for pro/enterprise),
  // so the local prune is skipped there.
  private readonly PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly LOCAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private lastPruneAt = 0;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly discovery: DiscoveryReaderService,
  ) {
    super(connectionRegistry);
    // Validate the env override: an empty, zero, negative, or non-numeric value
    // would otherwise yield NaN and schedule the poller back-to-back (and break
    // getHistory's window-based limit sizing). Fall back to the default and floor
    // it so a tiny value can't hammer the connection.
    const parsed = Number(process.env.AI_OBS_POLL_INTERVAL_MS);
    this.pollIntervalMs =
      Number.isFinite(parsed) && parsed > 0
        ? Math.max(parsed, MIN_POLL_INTERVAL_MS)
        : DEFAULT_POLL_INTERVAL_MS;
  }

  protected getIntervalMs(): number {
    return this.pollIntervalMs;
  }

  onModuleInit(): void {
    this.logger.log(`Starting AI cache/memory polling (interval: ${this.pollIntervalMs}ms)`);
    this.start();
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const now = Date.now();
    // Prune before the early return so removed libraries' samples still age out
    // on self-hosted even when this connection currently has no AI instances.
    await this.maybePruneLocally(now);

    const instances = await this.discovery.discoverWithClient(ctx.client);
    if (instances.length === 0) return;

    const samples: Omit<StoredAiCacheSample, 'id' | 'connectionId'>[] = [];

    for (const inst of instances) {
      try {
        const sample = await this.sampleInstance(ctx.client, inst, now);
        if (sample) samples.push(sample);
      } catch (err) {
        this.logger.debug(
          `Failed to sample ${inst.field} on ${ctx.connectionName}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (samples.length > 0) {
      await this.storage.saveAiCacheSamples(samples, ctx.connectionId);
    }
  }

  /** Local, community-window prune for self-hosted (cloud uses the tier-based sweep). */
  private async maybePruneLocally(now: number): Promise<void> {
    if (process.env.CLOUD_MODE === 'true') return;
    if (now - this.lastPruneAt <= this.PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    const cutoff = now - this.LOCAL_RETENTION_MS;
    try {
      await this.storage.pruneOldAiCacheSamples(cutoff);
    } catch (err) {
      this.logger.warn(
        `Local ai_cache_samples prune failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      await this.storage.pruneOldOtelSpans(cutoff);
    } catch (err) {
      this.logger.warn(
        `Local otel_spans prune failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Public: discovered instances + latest stored sample, for the controller. */
  async getInstances(connectionId?: string): Promise<AiInstanceWithSample[]> {
    // Resolve the effective connection so storage reads are scoped to the SAME
    // connection discovery ran against (the poller writes samples per connection).
    const resolvedId = connectionId ?? this.connectionRegistry.getDefaultId() ?? undefined;
    const client = this.connectionRegistry.get(resolvedId);
    const instances = await this.discovery.discoverWithClient(client);
    const out: AiInstanceWithSample[] = [];
    for (const instance of instances) {
      const history = await this.storage.getAiCacheHistory({
        connectionId: resolvedId,
        instanceField: instance.field,
        limit: 1,
      });
      out.push({ instance, latest: history.length ? history[history.length - 1] : null });
    }
    return out;
  }

  async getHistory(
    connectionId: string | undefined,
    instanceField: string,
    hours = 24,
  ): Promise<StoredAiCacheSample[]> {
    const resolvedId = connectionId ?? this.connectionRegistry.getDefaultId() ?? undefined;
    const endTime = Date.now();
    // Size the cap to the window so long ranges (e.g. 7d at a 15s poll) aren't
    // silently truncated by the storage default of 10,000 rows per instance.
    const expectedPoints = Math.ceil((hours * 60 * 60 * 1000) / this.pollIntervalMs) + 100;
    return this.storage.getAiCacheHistory({
      connectionId: resolvedId,
      instanceField,
      startTime: endTime - hours * 60 * 60 * 1000,
      endTime,
      limit: Math.max(10_000, expectedPoints),
    });
  }

  // --- OTLP traces (Phase 2) ---

  async getTraces(hours = 1, service?: string, limit = 100): Promise<OtelTraceSummary[]> {
    const endTime = Date.now();
    return this.storage.getOtelTraces({
      startTime: endTime - hours * 60 * 60 * 1000,
      endTime,
      service,
      limit,
    });
  }

  async getTraceSpans(traceId: string): Promise<StoredOtelSpan[]> {
    return this.storage.getOtelTraceSpans(traceId);
  }

  // --- per-kind sampling ---

  private async sampleInstance(
    client: DatabasePort,
    inst: AiInstance,
    now: number,
  ): Promise<Omit<StoredAiCacheSample, 'id' | 'connectionId'> | null> {
    let hits = 0;
    let misses = 0;
    let costSavedMicros = 0;
    let evictions = 0;
    let items: number | null = null;
    let indexBytes: number | null = null;
    let threshold: number | null = null;
    let extra: Record<string, unknown> | null = null;

    const statsKey = inst.statsKey ?? `${inst.name}:__stats`;

    if (inst.kind === 'agent_cache') {
      const s = await this.readHash(client, statsKey);
      const llmHits = num(s['llm:hits']);
      const llmMiss = num(s['llm:misses']);
      const toolHits = num(s['tool:hits']);
      const toolMiss = num(s['tool:misses']);
      hits = llmHits + toolHits;
      misses = llmMiss + toolMiss;
      costSavedMicros = num(s['cost_saved_micros']);
      extra = {
        llm: { hits: llmHits, misses: llmMiss },
        tool: { hits: toolHits, misses: toolMiss },
        session: { reads: num(s['session:reads']), writes: num(s['session:writes']) },
      };
    } else if (inst.kind === 'semantic_cache') {
      const s = await this.readHash(client, statsKey);
      hits = num(s['hits']);
      misses = num(s['misses']);
      costSavedMicros = num(s['cost_saved_micros']);
      const cfg = await this.readHash(client, `${inst.name}:__config`);
      threshold = 'threshold' in cfg ? num(cfg['threshold']) : null;
      extra = { similarity: await this.readSimilarityWindow(client, `${inst.name}:__similarity_window`) };
      const idx = await this.readIndex(client, inst.indexName);
      items = idx.items;
      indexBytes = idx.indexBytes;
    } else if (inst.kind === 'agent_memory') {
      const s = await this.readHash(client, statsKey);
      evictions = num(s['evictions']);
      const cfg = await this.readHash(client, `${inst.name}:__mem_config`);
      threshold = 'recall.threshold' in cfg ? num(cfg['recall.threshold']) : null;
      const idx = await this.readIndex(client, inst.indexName ?? `${inst.name}:mem:idx`);
      items = idx.items;
      indexBytes = idx.indexBytes;
    } else if (inst.kind === 'retrieval') {
      const idx = await this.readIndex(client, inst.indexName ?? `${inst.name}:idx`);
      items = idx.items;
      indexBytes = idx.indexBytes;
    }

    // Cumulative (lifetime) hit rate — stable regardless of skipped/failed polls,
    // unlike a per-tick delta which spreads counter growth across missed intervals.
    const total = hits + misses;
    const hitRate = total > 0 ? hits / total : null;

    return {
      instanceField: inst.field,
      instanceName: inst.name,
      kind: inst.kind,
      timestamp: now,
      hits,
      misses,
      hitRate,
      costSavedMicros,
      evictions,
      items,
      indexBytes,
      threshold,
      extra: extra ? JSON.stringify(extra) : null,
    };
  }

  private async readIndex(
    client: DatabasePort,
    indexName?: string,
  ): Promise<{ items: number | null; indexBytes: number | null }> {
    if (!indexName || !client.getCapabilities().hasVectorSearch) {
      return { items: null, indexBytes: null };
    }
    try {
      const info = await client.getVectorIndexInfo(indexName);
      return {
        items: info.numDocs ?? null,
        indexBytes: info.memorySizeMb != null ? Math.round(info.memorySizeMb * 1024 * 1024) : null,
      };
    } catch {
      return { items: null, indexBytes: null };
    }
  }

  private async readSimilarityWindow(
    client: DatabasePort,
    key: string,
  ): Promise<{ count: number; hits: number; avgScore: number | null }> {
    try {
      const raw = await client.call('ZRANGE', [key, String(-SIMILARITY_WINDOW_SAMPLE), '-1']);
      const members = Array.isArray(raw) ? raw.map(String) : [];
      let hits = 0;
      let scoreSum = 0;
      let scored = 0;
      for (const m of members) {
        try {
          const obj = JSON.parse(m) as { score?: number; result?: string };
          if (obj.result === 'hit' || obj.result === 'uncertain_hit') hits += 1;
          if (typeof obj.score === 'number') {
            scoreSum += obj.score;
            scored += 1;
          }
        } catch {
          /* skip malformed member */
        }
      }
      return { count: members.length, hits, avgScore: scored ? scoreSum / scored : null };
    } catch {
      return { count: 0, hits: 0, avgScore: null };
    }
  }

  private async readHash(client: DatabasePort, key: string): Promise<Record<string, string>> {
    const raw = await client.call('HGETALL', [key]);
    return parseHashReply(raw);
  }
}

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseHashReply(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
    return out;
  }
  if (raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}
