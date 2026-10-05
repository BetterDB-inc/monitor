import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  DEFAULT_SCALING_READINESS_ALERT_THRESHOLD,
  Feature,
  WEBHOOK_EVENTS_PRO_SERVICE,
  type IWebhookEventsProService,
  type ScalingReadiness,
  type ScalingReadinessHistory,
  type ScalingReadinessSettings,
  type ScalingReadinessSettingsUpdate,
} from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ScalingReadinessService } from '@app/scaling-readiness/scaling-readiness.service';
import { LicenseService } from '@proprietary/licenses';

const TICK_INTERVAL_MS = 60_000;
const HISTORY_FETCH_LIMIT = 50_000;
const HISTORY_MAX_POINTS = 1_000;

@Injectable()
export class ScalingReadinessProService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScalingReadinessProService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly lastStoredAt = new Map<string, number>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly readiness: ScalingReadinessService,
    private readonly connectionRegistry: ConnectionRegistry,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
    @Optional()
    private readonly licenseService?: LicenseService,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    if (this.licenseService?.hasFeature(Feature.SCALING_READINESS_HISTORY) !== true) return;
    this.running = true;
    try {
      const connections = this.connectionRegistry.list().filter((c) => c.isConnected);
      for (const connection of connections) {
        await this.processConnection(connection.id);
      }
    } catch (error) {
      this.logger.error(`Scaling readiness tick failed: ${this.describe(error)}`);
    } finally {
      this.running = false;
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
  }

  private async processConnection(connectionId: string): Promise<void> {
    let result: ScalingReadiness;
    try {
      result = await this.readiness.compute(connectionId);
    } catch (error) {
      this.logger.error(`Scaling readiness compute failed for ${connectionId}: ${this.describe(error)}`);
      return;
    }
    if (result.score === null || result.band === null) return;
    try {
      await this.storeScore(connectionId, result);
    } catch (error) {
      this.logger.error(`Scaling readiness save failed for ${connectionId}: ${this.describe(error)}`);
    }
    try {
      await this.checkAlert(connectionId, result);
    } catch (error) {
      this.logger.error(`Scaling readiness alert failed for ${connectionId}: ${this.describe(error)}`);
    }
  }

  private async storeScore(connectionId: string, result: ScalingReadiness): Promise<void> {
    if (result.score === null || result.band === null) return;
    const last = this.lastStoredAt.get(connectionId);
    if (last !== undefined && result.computedAt <= last) return;
    await this.storage.saveScalingReadinessScore({
      id: randomUUID(),
      connectionId,
      timestamp: result.computedAt,
      score: result.score,
      band: result.band,
      bindingDimension: result.bindingDimension,
      dimensions: result.dimensions,
    });
    this.lastStoredAt.set(connectionId, result.computedAt);
  }

  private async checkAlert(connectionId: string, result: ScalingReadiness): Promise<void> {
    if (!this.webhookEventsProService || result.score === null || result.band === null) return;
    const settings = await this.getSettings(connectionId);
    if (!settings.alertEnabled) return;
    const config = this.connectionRegistry.getConfig(connectionId);
    await this.webhookEventsProService.dispatchScalingReadinessLow({
      connectionId,
      score: result.score,
      threshold: settings.alertThreshold,
      band: result.band,
      bindingDimension: result.bindingDimension,
      summary: result.summary,
      dimensions: result.dimensions.map((d) => ({
        key: d.key,
        score: d.score,
        excludedReason: d.excludedReason,
      })),
      timestamp: Date.now(),
      instance: config ? { host: config.host, port: config.port } : undefined,
    });
  }

  async getHistory(connectionId: string, from: number, to: number): Promise<ScalingReadinessHistory> {
    const rows = await this.storage.getScalingReadinessScores({
      connectionId,
      from,
      to,
      limit: HISTORY_FETCH_LIMIT,
    });
    return {
      points: this.downsample(rows).map((r) => ({
        timestamp: r.timestamp,
        score: r.score,
        band: r.band,
        bindingDimension: r.bindingDimension,
        dimensions: r.dimensions,
      })),
    };
  }

  private downsample<T extends { timestamp: number; score: number }>(rows: T[]): T[] {
    if (rows.length <= HISTORY_MAX_POINTS) return rows;
    const start = rows[0].timestamp;
    const span = rows[rows.length - 1].timestamp - start;
    if (span <= 0) return rows.slice(0, 1);
    const bucketWidth = span / HISTORY_MAX_POINTS;
    const lowest = new Map<number, T>();
    for (const row of rows) {
      const bucket = Math.min(HISTORY_MAX_POINTS - 1, Math.floor((row.timestamp - start) / bucketWidth));
      const current = lowest.get(bucket);
      if (!current || row.score < current.score) lowest.set(bucket, row);
    }
    return [...lowest.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  }

  async getSettings(connectionId: string): Promise<ScalingReadinessSettings> {
    return (
      (await this.storage.getScalingReadinessSettings(connectionId)) ?? {
        connectionId,
        alertEnabled: true,
        alertThreshold: DEFAULT_SCALING_READINESS_ALERT_THRESHOLD,
        updatedAt: Date.now(),
      }
    );
  }

  async updateSettings(
    connectionId: string,
    update: ScalingReadinessSettingsUpdate,
  ): Promise<ScalingReadinessSettings> {
    const current = await this.getSettings(connectionId);
    const next: ScalingReadinessSettings = {
      ...current,
      ...(update.alertEnabled !== undefined ? { alertEnabled: update.alertEnabled } : {}),
      ...(update.alertThreshold !== undefined ? { alertThreshold: update.alertThreshold } : {}),
      updatedAt: Date.now(),
    };
    return this.storage.saveScalingReadinessSettings(next);
  }
}
