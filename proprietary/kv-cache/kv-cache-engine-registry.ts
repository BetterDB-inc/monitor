import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { StoragePort, StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { KvCacheFootprintService } from './kv-cache-footprint.service';
import { KvCacheSamplesService } from './kv-cache-samples.service';

export const KV_CACHE_LAST_SEEN_PERSIST_MS = 5 * 60_000;
export const REMOVAL_TOMBSTONE_MS = 60 * 60_000;

@Injectable()
export class KvCacheEngineRegistry implements OnModuleInit {
  private readonly logger = new Logger(KvCacheEngineRegistry.name);
  private readonly engines = new Map<string, StoredKvCacheEngine>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly statusVersions = new Map<string, number>();
  private readonly removed = new Map<string, number>();
  private readonly removals = new Map<string, number>();
  private readonly removedConnections = new Map<string, number>();
  private readonly persistedSeenAt = new Map<string, number | null>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly footprint: KvCacheFootprintService,
    private readonly samples: KvCacheSamplesService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const engine of await this.storage.getKvCacheEngines()) {
      this.engines.set(engine.id, engine);
      this.persistedSeenAt.set(engine.id, engine.lastSeenAt);
    }
    this.footprint.onConnectionRemoval(async (connectionId) => {
      this.removals.set(connectionId, (this.removals.get(connectionId) ?? 0) + 1);
      this.tombstone(this.removedConnections, connectionId);
      const ids = this.list(connectionId).map((engine) => engine.id);
      for (const id of ids) {
        this.tombstone(this.removed, id);
        this.engines.delete(id);
        this.statusVersions.delete(id);
        this.persistedSeenAt.delete(id);
        this.samples.forgetEngine(id);
      }
      await Promise.all(ids.map((id) => this.writes.get(id)));
      return this.samples.settled();
    });
    this.footprint.onConnectionRestore((connectionId) => this.restore(connectionId));
  }

  private async restore(connectionId: string): Promise<void> {
    this.removedConnections.delete(connectionId);
    const removals = this.removals.get(connectionId);
    const stored = (await this.storage.getKvCacheEngines()).filter((engine) => engine.connectionId === connectionId);
    if (this.removals.get(connectionId) !== removals) return;
    const superseded: string[] = [];
    for (const engine of stored) {
      if (this.engines.has(engine.id)) continue;
      if (this.clashes(engine)) {
        superseded.push(engine.id);
        continue;
      }
      this.removed.delete(engine.id);
      this.engines.set(engine.id, engine);
      this.persistedSeenAt.set(engine.id, engine.lastSeenAt);
    }
    await Promise.all(
      superseded.map((id) =>
        this.serialize(id, async () => {
          if (this.removals.get(connectionId) !== removals || this.engines.has(id)) return;
          await this.storage.deleteKvCacheEngine(id);
        }).catch((error) =>
          this.logger.warn(`Could not delete superseded KV cache engine ${id}: ${error instanceof Error ? error.message : String(error)}`),
        ),
      ),
    );
  }

  private clashes(engine: StoredKvCacheEngine): boolean {
    return [...this.engines.values()].some(
      (other) =>
        (other.connectionId === engine.connectionId && other.name === engine.name) ||
        (engine.otlpEngineId !== null && other.otlpEngineId === engine.otlpEngineId),
    );
  }

  list(connectionId?: string): StoredKvCacheEngine[] {
    const all = [...this.engines.values()];
    return connectionId === undefined ? all : all.filter((engine) => engine.connectionId === connectionId);
  }

  get(id: string): StoredKvCacheEngine | null {
    return this.engines.get(id) ?? null;
  }

  byOtlpId(otlpEngineId: string): StoredKvCacheEngine | null {
    for (const engine of this.engines.values()) {
      if (engine.otlpEngineId === otlpEngineId) return engine;
    }
    return null;
  }

  save(engine: StoredKvCacheEngine): Promise<StoredKvCacheEngine> {
    const version = this.statusVersions.get(engine.id);
    return this.serialize(engine.id, async () => {
      if (this.removed.has(engine.id)) throw new NotFoundException(`KV cache engine ${engine.id} not found`);
      this.assertConnectionLive(engine.connectionId);
      const removals = this.removals.get(engine.connectionId);
      const saved = await this.storage.saveKvCacheEngine(engine);
      if (this.removals.get(saved.connectionId) !== removals && !this.footprint.hasConnection(saved.connectionId)) {
        this.engines.delete(saved.id);
        this.statusVersions.delete(saved.id);
        this.persistedSeenAt.delete(saved.id);
        await this.storage.deleteKvCacheEngine(saved.id);
        throw new NotFoundException(`Connection '${saved.connectionId}' not found`);
      }
      if (this.removed.has(saved.id)) throw new NotFoundException(`KV cache engine ${saved.id} not found`);
      const latest = this.engines.get(saved.id);
      const merged =
        latest && latest.scrapeUrl === saved.scrapeUrl && this.statusVersions.get(saved.id) !== version
          ? { ...saved, lastSeenAt: latest.lastSeenAt, lastError: latest.lastError }
          : saved;
      this.engines.set(merged.id, merged);
      this.persistedSeenAt.set(merged.id, saved.lastSeenAt);
      return merged;
    });
  }

  remove(id: string): Promise<boolean> {
    this.tombstone(this.removed, id);
    return this.serialize(id, async () => {
      let removed: boolean;
      try {
        removed = await this.storage.deleteKvCacheEngine(id);
      } catch (error) {
        this.removed.delete(id);
        throw error;
      }
      this.engines.delete(id);
      this.statusVersions.delete(id);
      this.persistedSeenAt.delete(id);
      return removed;
    });
  }

  recordResult(id: string, result: { lastSeenAt?: number; lastError: string | null }): void {
    const current = this.engines.get(id);
    if (!current) return;
    const updated: StoredKvCacheEngine = {
      ...current,
      lastSeenAt: result.lastSeenAt ?? current.lastSeenAt,
      lastError: result.lastError,
    };
    this.engines.set(id, updated);
    this.statusVersions.set(id, (this.statusVersions.get(id) ?? 0) + 1);
    if (!this.needsPersist(id, current.lastError, updated)) return;
    this.persistedSeenAt.set(id, updated.lastSeenAt);
    void this.serialize(id, async () => {
      const latest = this.engines.get(id);
      if (latest && !this.removed.has(id)) await this.storage.saveKvCacheEngine(latest);
    }).catch((error) => this.logger.warn(`Could not persist KV cache engine ${id}: ${error instanceof Error ? error.message : String(error)}`));
  }

  private tombstone(tombstones: Map<string, number>, key: string): void {
    const now = Date.now();
    for (const [existing, removedAt] of tombstones) {
      if (now - removedAt > REMOVAL_TOMBSTONE_MS) tombstones.delete(existing);
    }
    tombstones.set(key, now);
  }

  private needsPersist(id: string, previousError: string | null, updated: StoredKvCacheEngine): boolean {
    if (previousError !== updated.lastError) return true;
    const persisted = this.persistedSeenAt.get(id);
    if (persisted === undefined || persisted === null) return updated.lastSeenAt !== null;
    return updated.lastSeenAt !== null && updated.lastSeenAt - persisted >= KV_CACHE_LAST_SEEN_PERSIST_MS;
  }

  private assertConnectionLive(connectionId: string): void {
    if (this.removedConnections.has(connectionId) && !this.footprint.hasConnection(connectionId)) {
      throw new NotFoundException(`Connection '${connectionId}' not found`);
    }
  }

  private serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.writes.get(id) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined);
    this.writes.set(id, tail);
    void tail.then(() => {
      if (this.writes.get(id) === tail) this.writes.delete(id);
    });
    return run;
  }
}
