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
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { LicenseService } from '@proprietary/licenses/license.service';
import { evictionConditions, shouldCheckHitRate, windowHitRates } from './kv-cache-alert-rules';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheFootprintService, type SnapshotContext } from './kv-cache-footprint.service';

const EVALUATE_INTERVAL_MS = 60_000;
const EVICTION_REASONS: KvCacheEvictionReason[] = ['unevictable', 'evicting'];
const EVICTING_CLEAR_SNAPSHOTS = 3;

interface CheckedWindow {
  engineId: string;
  engineName: string;
  model: string;
}

@Injectable()
export class KvCacheAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KvCacheAlertsService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly exportedConnections = new Set<string>();
  private readonly checkedWindows = new Map<string, Map<string, CheckedWindow>>();
  private readonly evictingCleanStreaks = new Map<string, number>();
  private readonly unevictableActive = new Set<string>();
  private evaluating = false;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly footprint: KvCacheFootprintService,
    private readonly registry: KvCacheEngineRegistry,
    private readonly license: LicenseService,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsPro?: IWebhookEventsProService,
    @Optional() private readonly prometheus?: PrometheusService,
  ) {}

  onModuleInit(): void {
    this.footprint.onSnapshot((snapshot, context) => this.onSnapshot(snapshot, context));
    this.footprint.onConnectionRemoval((connectionId) => {
      this.exportedConnections.delete(connectionId);
      this.checkedWindows.delete(connectionId);
      this.evictingCleanStreaks.delete(connectionId);
      this.unevictableActive.delete(connectionId);
      this.prometheus?.clearKvCache(connectionId);
    });
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

  async onSnapshot(snapshot: KvCacheFootprintSnapshot, context: SnapshotContext = { partial: false }): Promise<void> {
    try {
      if (!this.licensed()) return;
      if (snapshot.scanComplete) this.prometheus?.setKvCacheFootprint(snapshot.connectionId, snapshot.perModel);
      if (!this.webhookEventsPro) return;
      const settings = await this.getSettings(snapshot.connectionId);
      const conditions = this.evictionState(snapshot, settings.evictionAlertEnabled, context.partial);
      const instance = this.instanceFor(snapshot.connectionId);
      for (const reason of EVICTION_REASONS) {
        void this.webhookEventsPro
          .dispatchKvCacheEvictionRisk({
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
          })
          .catch((error: unknown) => this.warnEvictionFailure(snapshot.connectionId, error));
      }
    } catch (error) {
      this.warnEvictionFailure(snapshot.connectionId, error);
    }
  }

  private warnEvictionFailure(connectionId: string, error: unknown): void {
    this.logger.warn(`Eviction risk alert failed for ${connectionId}: ${error instanceof Error ? error.message : error}`);
  }

  private evictionState(
    snapshot: KvCacheFootprintSnapshot,
    enabled: boolean,
    partial: boolean,
  ): Record<KvCacheEvictionReason, boolean> {
    if (!enabled || (!partial && !snapshot.detected)) {
      this.evictingCleanStreaks.delete(snapshot.connectionId);
      this.unevictableActive.delete(snapshot.connectionId);
      return { unevictable: false, evicting: false };
    }
    if (partial) {
      return {
        unevictable: this.unevictableActive.has(snapshot.connectionId),
        evicting: this.evictingCleanStreaks.has(snapshot.connectionId),
      };
    }
    const conditions = evictionConditions(snapshot, this.unevictableActive.has(snapshot.connectionId));
    if (conditions.unevictable) this.unevictableActive.add(snapshot.connectionId);
    else this.unevictableActive.delete(snapshot.connectionId);
    conditions.evicting = this.holdEvicting(snapshot.connectionId, conditions.evicting);
    return conditions;
  }

  private holdEvicting(connectionId: string, evicting: boolean): boolean {
    if (evicting) {
      this.evictingCleanStreaks.set(connectionId, 0);
      return true;
    }
    const streak = this.evictingCleanStreaks.get(connectionId);
    if (streak === undefined) return false;
    if (streak + 1 >= EVICTING_CLEAR_SNAPSHOTS) {
      this.evictingCleanStreaks.delete(connectionId);
      return false;
    }
    this.evictingCleanStreaks.set(connectionId, streak + 1);
    return true;
  }

  async evaluateHitRates(now = Date.now()): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      if (!this.licensed()) return;
      const connectionIds = new Set([
        ...this.registry.list().map((engine) => engine.connectionId),
        ...this.exportedConnections,
        ...this.checkedWindows.keys(),
      ]);
      for (const connectionId of connectionIds) {
        try {
          await this.evaluateConnection(connectionId, now);
        } catch (error) {
          this.logger.warn(`Hit rate alert evaluation failed for ${connectionId}: ${error instanceof Error ? error.message : error}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Hit rate alert evaluation failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.evaluating = false;
    }
  }

  private async evaluateConnection(connectionId: string, now: number): Promise<void> {
    const rows = await this.storage.getKvCacheEngineSamples({ connectionId, from: now - KV_CACHE_HIT_RATE_WINDOW_MS, to: now });
    const settings = await this.getSettings(connectionId);
    const instance = this.instanceFor(connectionId);
    const windows = windowHitRates(rows);
    const resolved = windows.map((window) => ({ window, engine: this.registry.get(window.engineId) }));
    const rates = resolved.flatMap(({ window, engine }) =>
      engine?.enabled && window.hitRate !== null
        ? [{ engine: engine.name, model: window.model, hitRate: window.hitRate }]
        : [],
    );
    this.prometheus?.setKvCacheHitRates(connectionId, rates);
    if (rates.length > 0) this.exportedConnections.add(connectionId);
    else this.exportedConnections.delete(connectionId);
    if (!this.webhookEventsPro) return;
    const checked = new Map<string, CheckedWindow>();
    const previous = this.checkedWindows.get(connectionId);
    for (const { window, engine } of resolved) {
      if (!engine?.enabled || !settings.hitRateAlertEnabled) continue;
      const key = JSON.stringify([window.engineId, window.model]);
      if (window.hitRate === null || !shouldCheckHitRate(window, settings)) {
        const held = previous?.get(key);
        if (held) checked.set(key, held);
        continue;
      }
      const target = { engineId: window.engineId, engineName: engine.name, model: window.model };
      checked.set(key, target);
      await this.dispatchHitRate(connectionId, target, window.hitRate, window.requestedTokens, settings, now, instance);
    }
    for (const [key, target] of previous ?? []) {
      if (!checked.has(key)) await this.dispatchHitRate(connectionId, target, 1, 0, settings, now, instance);
    }
    if (checked.size > 0) this.checkedWindows.set(connectionId, checked);
    else this.checkedWindows.delete(connectionId);
  }

  private async dispatchHitRate(
    connectionId: string,
    target: CheckedWindow,
    hitRate: number,
    requestedTokens: number,
    settings: KvCacheSettings,
    now: number,
    instance: { host: string; port: number } | undefined,
  ): Promise<void> {
    try {
      await this.webhookEventsPro?.dispatchKvCacheHitRateLow({
        connectionId,
        engineId: target.engineId,
        engineName: target.engineName,
        model: target.model,
        hitRate,
        threshold: settings.hitRateThreshold,
        requestedTokens,
        windowMs: KV_CACHE_HIT_RATE_WINDOW_MS,
        timestamp: now,
        ...(instance ? { instance } : {}),
      });
    } catch (error) {
      this.logger.warn(`Hit rate alert dispatch failed for ${target.engineId}/${target.model}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private licensed(): boolean {
    if (this.license.hasFeature(Feature.KV_CACHE_MONITORING)) return true;
    this.prometheus?.clearAllKvCache();
    this.exportedConnections.clear();
    return false;
  }

  private instanceFor(connectionId: string): { host: string; port: number } | undefined {
    const config = this.connectionRegistry.getConfig(connectionId);
    return config ? { host: config.host, port: config.port } : undefined;
  }
}
