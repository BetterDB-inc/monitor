import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  DEFAULT_KV_CACHE_HIT_RATE_THRESHOLD,
  Feature,
  KV_CACHE_HIT_RATE_WINDOW_MS,
  WEBHOOK_EVENTS_PRO_SERVICE,
  type IWebhookEventsProService,
  type KvCacheEvictionReason,
  type KvCacheFootprintSnapshot,
  type KvCacheSettings,
  type KvCacheSettingsUpdate,
} from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseService } from '@proprietary/licenses/license.service';
import { evictionConditions, shouldCheckHitRate, windowHitRates } from './kv-cache-alert-rules';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheFootprintService } from './kv-cache-footprint.service';

const EVALUATE_INTERVAL_MS = 60_000;
const EVICTION_REASONS: KvCacheEvictionReason[] = ['unevictable', 'evicting'];

@Injectable()
export class KvCacheAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KvCacheAlertsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly footprint: KvCacheFootprintService,
    private readonly registry: KvCacheEngineRegistry,
    private readonly license: LicenseService,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsPro?: IWebhookEventsProService,
  ) {}

  onModuleInit(): void {
    this.footprint.onSnapshot((snapshot) => this.onSnapshot(snapshot));
    this.timer = setInterval(() => void this.evaluateHitRates(), EVALUATE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async getSettings(connectionId: string): Promise<KvCacheSettings> {
    const stored = await this.storage.getKvCacheSettings(connectionId);
    return (
      stored ?? {
        connectionId,
        hitRateAlertEnabled: true,
        hitRateThreshold: DEFAULT_KV_CACHE_HIT_RATE_THRESHOLD,
        evictionAlertEnabled: true,
        updatedAt: 0,
      }
    );
  }

  async updateSettings(connectionId: string, update: KvCacheSettingsUpdate): Promise<KvCacheSettings> {
    const current = await this.getSettings(connectionId);
    const definedUpdate = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
    return this.storage.saveKvCacheSettings({ ...current, ...definedUpdate, connectionId, updatedAt: Date.now() });
  }

  async onSnapshot(snapshot: KvCacheFootprintSnapshot): Promise<void> {
    try {
      if (!this.webhookEventsPro || !this.license.hasFeature(Feature.KV_CACHE_MONITORING)) return;
      const settings = await this.getSettings(snapshot.connectionId);
      if (!settings.evictionAlertEnabled) return;
      const conditions = evictionConditions(snapshot);
      const instance = this.instanceFor(snapshot.connectionId);
      for (const reason of EVICTION_REASONS) {
        await this.webhookEventsPro.dispatchKvCacheEvictionRisk({
          connectionId: snapshot.connectionId,
          reason,
          active: conditions[reason],
          policy: snapshot.maxmemoryPolicy,
          usedMemory: snapshot.usedMemory,
          maxmemory: snapshot.maxmemory,
          lmcacheMemoryShare: snapshot.lmcacheMemoryShare,
          noTtlRatio: snapshot.noTtlRatio,
          evictedKeysDelta: snapshot.evictedKeysDelta,
          timestamp: snapshot.timestamp,
          ...(instance ? { instance } : {}),
        });
      }
    } catch (error) {
      this.logger.warn(`Eviction risk alert failed for ${snapshot.connectionId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async evaluateHitRates(now = Date.now()): Promise<void> {
    if (!this.webhookEventsPro || !this.license.hasFeature(Feature.KV_CACHE_MONITORING)) return;
    const connectionIds = new Set(this.registry.list().filter((engine) => engine.enabled).map((engine) => engine.connectionId));
    for (const connectionId of connectionIds) {
      try {
        await this.evaluateConnection(connectionId, now);
      } catch (error) {
        this.logger.warn(`Hit rate alert evaluation failed for ${connectionId}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private async evaluateConnection(connectionId: string, now: number): Promise<void> {
    const rows = await this.storage.getKvCacheEngineSamples({ connectionId, from: now - KV_CACHE_HIT_RATE_WINDOW_MS, to: now });
    const settings = await this.getSettings(connectionId);
    const instance = this.instanceFor(connectionId);
    for (const window of windowHitRates(rows)) {
      const engine = this.registry.get(window.engineId);
      if (!engine || window.hitRate === null || !shouldCheckHitRate(window, settings)) continue;
      await this.webhookEventsPro?.dispatchKvCacheHitRateLow({
        connectionId,
        engineId: window.engineId,
        engineName: engine.name,
        model: window.model,
        hitRate: window.hitRate,
        threshold: settings.hitRateThreshold,
        requestedTokens: window.requestedTokens,
        windowMs: KV_CACHE_HIT_RATE_WINDOW_MS,
        timestamp: now,
        ...(instance ? { instance } : {}),
      });
    }
  }

  private instanceFor(connectionId: string): { host: string; port: number } | undefined {
    const config = this.connectionRegistry.getConfig(connectionId);
    return config ? { host: config.host, port: config.port } : undefined;
  }
}
