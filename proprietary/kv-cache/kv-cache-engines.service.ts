import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import type { KvCacheEngine } from '@betterdb/shared';
import type { StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import type { CreateKvCacheEngineDto, UpdateKvCacheEngineDto } from './dto/kv-cache-engine.dto';
import { KvCacheSamplesService } from './kv-cache-samples.service';
import { fetchMetricsText, ScrapeError } from './metrics-fetch';
import { parseLmcacheMetrics } from './prometheus-text';
import { toPublicEngine } from './kv-cache-status.service';

export const OTLP_ENGINE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const NO_METRICS = 'no lmcache metrics found';

type StoredAuth = Pick<StoredKvCacheEngine, 'scrapeAuthHeader' | 'scrapeAuthEncrypted'>;

@Injectable()
export class KvCacheEnginesService {
  private readonly logger = new Logger(KvCacheEnginesService.name);

  constructor(
    private readonly registry: KvCacheEngineRegistry,
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly samples: KvCacheSamplesService,
  ) {}

  list(connectionId: string): KvCacheEngine[] {
    return this.registry.list(connectionId).map(toPublicEngine);
  }

  async create(connectionId: string, dto: CreateKvCacheEngineDto): Promise<KvCacheEngine> {
    const base = {
      id: randomUUID(),
      connectionId,
      name: dto.name,
      enabled: dto.enabled ?? true,
      createdAt: Date.now(),
    };
    if (dto.source === 'otlp') return this.createOtlp(base, dto);
    if (!dto.scrapeUrl) throw new BadRequestException('scrapeUrl is required for scrape engines');
    const lastError = await this.testScrape(dto.scrapeUrl, dto.scrapeAuthHeader ?? null);
    const saved = await this.registry.save({
      ...base,
      source: 'scrape',
      scrapeUrl: dto.scrapeUrl,
      ...this.storeAuthHeader(dto.scrapeAuthHeader ?? null),
      otlpEngineId: null,
      lastSeenAt: Date.now(),
      lastError,
    });
    return toPublicEngine(saved);
  }

  async update(connectionId: string, id: string, dto: UpdateKvCacheEngineDto): Promise<KvCacheEngine> {
    const engine = this.owned(connectionId, id);
    let probe: { lastError: string | null; lastSeenAt: number } | null = null;
    if (engine.source === 'scrape') {
      const urlChanged = dto.scrapeUrl !== undefined && dto.scrapeUrl !== engine.scrapeUrl;
      const newHeader = typeof dto.scrapeAuthHeader === 'string' && dto.scrapeAuthHeader !== '';
      if (urlChanged && dto.scrapeAuthHeader === undefined && engine.scrapeAuthHeader && !this.sameOrigin(engine.scrapeUrl, dto.scrapeUrl)) {
        throw new BadRequestException('Re-enter the scrape auth header when changing the scrape URL origin');
      }
      const url = dto.scrapeUrl ?? engine.scrapeUrl;
      if ((urlChanged || newHeader) && url) {
        const header = dto.scrapeAuthHeader === undefined ? this.authHeaderFor(engine) : dto.scrapeAuthHeader || null;
        probe = { lastError: await this.testScrape(url, header), lastSeenAt: Date.now() };
      }
    }
    const fresh = this.owned(connectionId, id);
    const next: StoredKvCacheEngine = { ...fresh };
    if (dto.name !== undefined) next.name = dto.name;
    if (dto.enabled !== undefined) next.enabled = dto.enabled;
    if (fresh.source === 'scrape') {
      if (dto.scrapeUrl !== undefined) next.scrapeUrl = dto.scrapeUrl;
      if (dto.scrapeAuthHeader !== undefined) Object.assign(next, this.storeAuthHeader(dto.scrapeAuthHeader || null));
      if (probe) Object.assign(next, probe);
    }
    const saved = await this.registry.save(next);
    if (fresh.enabled !== saved.enabled || fresh.scrapeUrl !== saved.scrapeUrl) this.samples.resetBaselines(id);
    return toPublicEngine(saved);
  }

  async remove(connectionId: string, id: string): Promise<void> {
    this.owned(connectionId, id);
    await this.registry.remove(id);
    await this.samples.deleteEngine(id);
  }

  authHeaderFor(engine: StoredKvCacheEngine): string | null {
    if (!engine.scrapeAuthHeader) return null;
    if (!engine.scrapeAuthEncrypted) return engine.scrapeAuthHeader;
    const encryption = this.connectionRegistry.getEncryptionService();
    if (encryption) {
      try {
        return encryption.decrypt(engine.scrapeAuthHeader);
      } catch {
        this.warnUndecryptable(engine.id);
        return null;
      }
    }
    this.warnUndecryptable(engine.id);
    return null;
  }

  private sameOrigin(a: string | null, b: string | undefined): boolean {
    try {
      return new URL(a ?? '').origin === new URL(b ?? '').origin;
    } catch {
      return false;
    }
  }

  private warnUndecryptable(id: string): void {
    this.logger.warn(`Could not decrypt the scrape auth header for engine ${id}`);
  }

  private owned(connectionId: string, id: string): StoredKvCacheEngine {
    const engine = this.registry.get(id);
    if (!engine || engine.connectionId !== connectionId) throw new NotFoundException('Engine not found');
    return engine;
  }

  private async createOtlp(
    base: Pick<StoredKvCacheEngine, 'id' | 'connectionId' | 'name' | 'enabled' | 'createdAt'>,
    dto: CreateKvCacheEngineDto,
  ): Promise<KvCacheEngine> {
    const otlpEngineId = dto.otlpEngineId ?? 'lmc-' + randomBytes(6).toString('hex');
    if (!OTLP_ENGINE_ID_PATTERN.test(otlpEngineId)) throw new BadRequestException('Invalid OTLP engine id');
    if (this.registry.byOtlpId(otlpEngineId)) throw new ConflictException('OTLP engine id already in use');
    const saved = await this.registry.save({
      ...base,
      source: 'otlp',
      scrapeUrl: null,
      scrapeAuthHeader: null,
      scrapeAuthEncrypted: false,
      otlpEngineId,
      lastSeenAt: null,
      lastError: null,
    });
    return toPublicEngine(saved);
  }

  private async testScrape(url: string, header: string | null): Promise<string | null> {
    try {
      const text = await fetchMetricsText(url, header);
      return parseLmcacheMetrics(text).length === 0 ? NO_METRICS : null;
    } catch (error) {
      if (error instanceof ScrapeError) throw new BadRequestException(`Test scrape failed: ${error.message}`);
      throw error;
    }
  }

  private storeAuthHeader(header: string | null): StoredAuth {
    if (!header) return { scrapeAuthHeader: null, scrapeAuthEncrypted: false };
    const encryption = this.connectionRegistry.getEncryptionService();
    return encryption
      ? { scrapeAuthHeader: encryption.encrypt(header), scrapeAuthEncrypted: true }
      : { scrapeAuthHeader: header, scrapeAuthEncrypted: false };
  }
}
