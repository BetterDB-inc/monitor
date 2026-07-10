import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import type { AiInstance, StoredAiCacheSample } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import { DiscoveryReaderService } from './discovery-reader.service';

/** Cumulative counters retained between ticks so we can derive a per-tick hit rate. */
interface CounterState {
  hits: number;
  misses: number;
}

/** An instance plus its most recent polled sample (for the API). */
export interface AiInstanceWithSample {
  instance: AiInstance;
  latest: StoredAiCacheSample | null;
}

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const SIMILARITY_WINDOW_SAMPLE = 200;

@Injectable()
export class AiObservabilityService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(AiObservabilityService.name);
  private readonly pollIntervalMs: number;

  /** key = `${connectionId}|${field}` → last cumulative counters (for hit-rate deltas). */
  private lastCounters = new Map<string, CounterState>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly discovery: DiscoveryReaderService,
  ) {
    super(connectionRegistry);
    this.pollIntervalMs = Number(
      process.env.AI_OBS_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
    );
  }

  protected getIntervalMs(): number {
    return this.pollIntervalMs;
  }

  onModuleInit(): void {
    this.logger.log(`Starting AI cache/memory polling (interval: ${this.pollIntervalMs}ms)`);
    this.start();
  }

  protected onConnectionRemoved(connectionId: string): void {
    for (const key of [...this.lastCounters.keys()]) {
      if (key.startsWith(`${connectionId}|`)) this.lastCounters.delete(key);
    }
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const instances = await this.discovery.discoverWithClient(ctx.client);
    if (instances.length === 0) return;

    const now = Date.now();
    const samples: Omit<StoredAiCacheSample, 'id' | 'connectionId'>[] = [];

    for (const inst of instances) {
      try {
        const sample = await this.sampleInstance(ctx.client, ctx.connectionId, inst, now);
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

  /** Public: discovered instances + latest stored sample, for the controller. */
  async getInstances(connectionId?: string): Promise<AiInstanceWithSample[]> {
    const client = this.connectionRegistry.get(connectionId);
    const instances = await this.discovery.discoverWithClient(client);
    const out: AiInstanceWithSample[] = [];
    for (const instance of instances) {
      const history = await this.storage.getAiCacheHistory({
        connectionId,
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
    const endTime = Date.now();
    return this.storage.getAiCacheHistory({
      connectionId,
      instanceField,
      startTime: endTime - hours * 60 * 60 * 1000,
      endTime,
    });
  }

  // --- per-kind sampling ---

  private async sampleInstance(
    client: DatabasePort,
    connectionId: string,
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

    const hitRate = this.deriveHitRate(connectionId, inst.field, hits, misses);

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

  /** Per-tick hit rate from the delta of cumulative counters; null on the first sample. */
  private deriveHitRate(
    connectionId: string,
    field: string,
    hits: number,
    misses: number,
  ): number | null {
    const key = `${connectionId}|${field}`;
    const prev = this.lastCounters.get(key);
    this.lastCounters.set(key, { hits, misses });
    if (!prev) return null;
    const dHits = hits - prev.hits;
    const dMisses = misses - prev.misses;
    const total = dHits + dMisses;
    // Counter reset (restart) or no traffic this tick → no meaningful rate.
    if (dHits < 0 || dMisses < 0 || total <= 0) return null;
    return dHits / total;
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
