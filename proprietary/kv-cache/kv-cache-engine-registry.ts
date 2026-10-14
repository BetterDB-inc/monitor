import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { StoragePort, StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { KvCacheFootprintService } from './kv-cache-footprint.service';
import { KvCacheSamplesService } from './kv-cache-samples.service';

@Injectable()
export class KvCacheEngineRegistry implements OnModuleInit {
  private readonly logger = new Logger(KvCacheEngineRegistry.name);
  private readonly engines = new Map<string, StoredKvCacheEngine>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly statusVersions = new Map<string, number>();
  private readonly removed = new Set<string>();
  private readonly removals = new Map<string, number>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly footprint: KvCacheFootprintService,
    private readonly samples: KvCacheSamplesService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const engine of await this.storage.getKvCacheEngines()) this.engines.set(engine.id, engine);
    this.footprint.onConnectionRemoval(async (connectionId) => {
      this.removals.set(connectionId, (this.removals.get(connectionId) ?? 0) + 1);
      const ids = this.list(connectionId).map((engine) => engine.id);
      for (const id of ids) {
        this.removed.add(id);
        this.engines.delete(id);
        this.statusVersions.delete(id);
        this.samples.forgetEngine(id);
      }
      await Promise.all(ids.map((id) => this.writes.get(id)));
      return this.samples.settled();
    });
    this.footprint.onConnectionRestore((connectionId) => this.restore(connectionId));
  }

  private async restore(connectionId: string): Promise<void> {
    const removals = this.removals.get(connectionId);
    const stored = (await this.storage.getKvCacheEngines()).filter((engine) => engine.connectionId === connectionId);
    if (this.removals.get(connectionId) !== removals) return;
    for (const engine of stored) {
      if (this.engines.has(engine.id)) continue;
      if (this.clashes(engine)) {
        await this.serialize(engine.id, () => this.storage.deleteKvCacheEngine(engine.id)).catch((error) =>
          this.logger.warn(`Could not delete superseded KV cache engine ${engine.id}: ${error instanceof Error ? error.message : String(error)}`),
        );
        continue;
      }
      this.removed.delete(engine.id);
      this.engines.set(engine.id, engine);
    }
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
    return this.serialize(engine.id, async () => {
      if (this.removed.has(engine.id)) return engine;
      const version = this.statusVersions.get(engine.id);
      const saved = await this.storage.saveKvCacheEngine(engine);
      if (this.removed.has(saved.id)) return saved;
      const latest = this.engines.get(saved.id);
      const merged =
        latest && this.statusVersions.get(saved.id) !== version
          ? { ...saved, lastSeenAt: latest.lastSeenAt, lastError: latest.lastError }
          : saved;
      this.engines.set(merged.id, merged);
      return merged;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.serialize(id, async () => {
      const removed = await this.storage.deleteKvCacheEngine(id);
      this.engines.delete(id);
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
    void this.serialize(id, async () => {
      const latest = this.engines.get(id);
      if (latest && !this.removed.has(id)) await this.storage.saveKvCacheEngine(latest);
    }).catch((error) => this.logger.warn(`Could not persist KV cache engine ${id}: ${error instanceof Error ? error.message : String(error)}`));
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
