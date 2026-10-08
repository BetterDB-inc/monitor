import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { StoragePort, StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { KvCacheFootprintService } from './kv-cache-footprint.service';

@Injectable()
export class KvCacheEngineRegistry implements OnModuleInit {
  private readonly logger = new Logger(KvCacheEngineRegistry.name);
  private readonly engines = new Map<string, StoredKvCacheEngine>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly footprint: KvCacheFootprintService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const engine of await this.storage.getKvCacheEngines()) this.engines.set(engine.id, engine);
    this.footprint.onConnectionRemoval((connectionId) => {
      for (const [id, engine] of this.engines) {
        if (engine.connectionId === connectionId) this.engines.delete(id);
      }
    });
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

  async save(engine: StoredKvCacheEngine): Promise<StoredKvCacheEngine> {
    const saved = await this.storage.saveKvCacheEngine(engine);
    this.engines.set(saved.id, saved);
    return saved;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.storage.deleteKvCacheEngine(id);
    this.engines.delete(id);
    return removed;
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
    void this.storage
      .saveKvCacheEngine(updated)
      .catch((error) => this.logger.warn(`Could not persist KV cache engine ${id}: ${error instanceof Error ? error.message : String(error)}`));
  }
}
