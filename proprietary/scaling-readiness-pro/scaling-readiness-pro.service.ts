import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  DEFAULT_SCALING_READINESS_ALERT_THRESHOLD,
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

const TICK_INTERVAL_MS = 60_000;

@Injectable()
export class ScalingReadinessProService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScalingReadinessProService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly readiness: ScalingReadinessService,
    private readonly connectionRegistry: ConnectionRegistry,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
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
    this.running = true;
    try {
      const connections = this.connectionRegistry.list().filter((c) => c.isConnected);
      for (const connection of connections) {
        try {
          await this.processConnection(connection.id);
        } catch (error) {
          this.logger.error(
            `Scaling readiness tick failed for ${connection.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async processConnection(connectionId: string): Promise<void> {
    const result = await this.readiness.compute(connectionId);
    if (result.score === null || result.band === null) return;
    await this.storage.saveScalingReadinessScore({
      id: randomUUID(),
      connectionId,
      timestamp: Date.now(),
      score: result.score,
      band: result.band,
      bindingDimension: result.bindingDimension,
      dimensions: result.dimensions,
    });
    await this.checkAlert(connectionId, result);
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
    const rows = await this.storage.getScalingReadinessScores({ connectionId, from, to });
    return {
      points: rows.map((r) => ({
        timestamp: r.timestamp,
        score: r.score,
        band: r.band,
        bindingDimension: r.bindingDimension,
        dimensions: r.dimensions,
      })),
    };
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
