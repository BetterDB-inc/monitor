import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CaptureTriggerPatch,
  CaptureTriggerQueryOptions,
  StoredCaptureTrigger,
  WebhookEventType,
} from '@betterdb/shared';
import { StoragePort, StoredAnomalyEvent } from '../common/interfaces/storage-port.interface';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';

/** Default trigger lifetime when caller does not specify one. Matches PRD: auto-clears in 24h. */
export const DEFAULT_TRIGGER_EXPIRY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface CreateTriggerInput {
  connectionId: string;
  metricType: string;
  anomalyType: string;
  expiresAt?: number;
  createdBy?: string;
}

export interface CaptureTriggerRegistryOptions {
  pollIntervalMs?: number;
  /** When false, onModuleInit does not start the polling loop (used by tests). */
  autoStart?: boolean;
}

/**
 * Pro+ capture trigger registry. Owns the trigger lifecycle state machine and
 * drives a polling loop that:
 *   1. expires stale triggers (now &gt; expiresAt),
 *   2. retries previously queued triggers when the connection frees up,
 *   3. matches new anomaly events against configured triggers and fires them.
 *
 * The deep-module test seam is {@link tick}: callers can drive iterations
 * manually without timers. `setOptions` lets specs override the poll interval
 * and disable auto-start.
 */
@Injectable()
export class CaptureTriggerRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptureTriggerRegistry.name);
  private pollHandle?: NodeJS.Timeout;
  private lastAnomalyAt: number;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private autoStart = true;
  private ticking = false;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly captureService: MonitorCaptureService,
    private readonly healthGate: HealthGateService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {
    // Seed the watermark to "now" so a process restart never replays
    // historical anomalies as if they just arrived. The trigger.createdAt
    // guard in processNewAnomalies() blocks events older than each trigger
    // anyway, but starting from 0 still means an unbounded scan on first
    // tick. Tests can reset via the test seam below.
    this.lastAnomalyAt = Date.now();
  }

  /** Test seam — reset the anomaly watermark so specs see all stored events. */
  resetAnomalyWatermark(): void {
    this.lastAnomalyAt = 0;
  }

  setOptions(options: CaptureTriggerRegistryOptions): void {
    if (options.pollIntervalMs !== undefined) {
      this.pollIntervalMs = options.pollIntervalMs;
    }
    if (options.autoStart !== undefined) {
      this.autoStart = options.autoStart;
    }
  }

  onModuleInit(): void {
    if (!this.autoStart) {
      return;
    }
    if (process.env.MONITOR_DEV_PREVIEW !== 'true') {
      return;
    }
    this.pollHandle = setInterval(() => {
      this.tick().catch((err: Error) => {
        this.logger.error(`CaptureTriggerRegistry tick failed: ${err.message}`);
      });
    }, this.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  async createTrigger(input: CreateTriggerInput): Promise<StoredCaptureTrigger> {
    const conflicting = await this.findActiveTrigger(
      input.connectionId,
      input.metricType,
      input.anomalyType,
    );
    if (conflicting) {
      throw new ConflictException(
        `A capture trigger for ${input.metricType}/${input.anomalyType} on ${input.connectionId} already exists`,
      );
    }

    const now = Date.now();
    const trigger: StoredCaptureTrigger = {
      id: randomUUID(),
      connectionId: input.connectionId,
      metricType: input.metricType,
      anomalyType: input.anomalyType,
      expiresAt: input.expiresAt ?? now + DEFAULT_TRIGGER_EXPIRY_MS,
      createdAt: now,
      createdBy: input.createdBy,
      status: 'configured',
    };
    await this.storage.saveCaptureTrigger(trigger);
    void this.dispatchTriggerCreated(trigger);
    return trigger;
  }

  async cancelTrigger(id: string): Promise<boolean> {
    const existing = await this.storage.getCaptureTrigger(id);
    if (!existing) {
      return false;
    }
    if (existing.status !== 'configured' && existing.status !== 'queued') {
      return false;
    }
    return this.storage.updateCaptureTrigger(id, { status: 'cancelled' });
  }

  listTriggers(
    options: CaptureTriggerQueryOptions = {},
  ): Promise<StoredCaptureTrigger[]> {
    return this.storage.getCaptureTriggers(options);
  }

  getTrigger(id: string): Promise<StoredCaptureTrigger | null> {
    return this.storage.getCaptureTrigger(id);
  }

  /**
   * Run one polling iteration. Public so tests can drive the registry without
   * setInterval. Re-entrancy is suppressed: overlapping ticks short-circuit.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.sweepExpired();
      await this.processQueued();
      await this.processNewAnomalies();
    } finally {
      this.ticking = false;
    }
  }

  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    const [configured, queued] = await Promise.all([
      this.storage.getCaptureTriggers({ status: 'configured' }),
      this.storage.getCaptureTriggers({ status: 'queued' }),
    ]);
    for (const trigger of [...configured, ...queued]) {
      if (trigger.expiresAt <= now) {
        await this.storage.updateCaptureTrigger(trigger.id, { status: 'expired' });
      }
    }
  }

  private async processQueued(): Promise<void> {
    const queued = await this.storage.getCaptureTriggers({ status: 'queued' });
    for (const trigger of queued) {
      if (this.captureService.hasActiveSessionOn(trigger.connectionId)) {
        continue;
      }
      await this.tryFire(trigger);
    }
  }

  private async processNewAnomalies(): Promise<void> {
    const startTime = this.lastAnomalyAt === 0 ? 0 : this.lastAnomalyAt + 1;
    const pageSize = 200;
    // Drain pagination by walking offset until storage returns fewer rows
    // than requested. Cap total work per tick so a runaway backlog can't
    // starve other tick steps.
    const maxPerTick = 5000;
    const collected: StoredAnomalyEvent[] = [];
    for (let offset = 0; offset < maxPerTick; offset += pageSize) {
      const page = await this.storage.getAnomalyEvents({
        startTime,
        limit: pageSize,
        offset,
      });
      if (page.length === 0) {
        break;
      }
      collected.push(...page);
      if (page.length < pageSize) {
        break;
      }
    }
    if (collected.length === 0) {
      return;
    }
    // Storage returns DESC by timestamp; iterate oldest-first so a partial
    // drain still leaves a coherent watermark.
    const sorted = collected.sort((a, b) => a.timestamp - b.timestamp);
    let maxTs = this.lastAnomalyAt;
    for (const evt of sorted) {
      if (evt.timestamp > maxTs) {
        maxTs = evt.timestamp;
      }
      if (!evt.connectionId) {
        continue;
      }
      const match = await this.findActiveTrigger(
        evt.connectionId,
        evt.metricType,
        evt.anomalyType,
      );
      if (match && match.status === 'configured' && evt.timestamp >= match.createdAt) {
        await this.tryFire(match);
      }
    }
    this.lastAnomalyAt = maxTs;
  }

  private async tryFire(trigger: StoredCaptureTrigger): Promise<void> {
    const gate = await this.healthGate.evaluate(trigger.connectionId);
    if (!gate.allow) {
      const reason = gate.skipReason ?? 'health_gate_blocked';
      await this.patch(trigger.id, { status: 'skipped', skipReason: reason });
      void this.dispatchSessionSkipped(trigger, reason);
      return;
    }
    if (this.captureService.hasActiveSessionOn(trigger.connectionId)) {
      if (trigger.status !== 'queued') {
        await this.patch(trigger.id, { status: 'queued' });
      }
      return;
    }
    try {
      const session = await this.captureService.startSession({
        connectionId: trigger.connectionId,
        source: 'trigger',
        triggerId: trigger.id,
      });
      await this.patch(trigger.id, {
        status: 'fired',
        firedAt: Date.now(),
        firedSessionId: session.id,
      });
    } catch (err) {
      const message = (err as Error).message ?? 'unknown';
      if (message.includes('already active')) {
        await this.patch(trigger.id, { status: 'queued' });
        return;
      }
      this.logger.error(`Failed to start triggered session: ${message}`);
      await this.patch(trigger.id, {
        status: 'skipped',
        skipReason: `start_failed: ${message}`,
      });
    }
  }

  private async findActiveTrigger(
    connectionId: string,
    metricType: string,
    anomalyType: string,
  ): Promise<StoredCaptureTrigger | null> {
    const [configured, queued] = await Promise.all([
      this.storage.getCaptureTriggers({ connectionId, status: 'configured' }),
      this.storage.getCaptureTriggers({ connectionId, status: 'queued' }),
    ]);
    const all = [...configured, ...queued];
    const match = all.find((t) => {
      return t.metricType === metricType && t.anomalyType === anomalyType;
    });
    return match ?? null;
  }

  private patch(id: string, patch: CaptureTriggerPatch): Promise<boolean> {
    return this.storage.updateCaptureTrigger(id, patch);
  }

  private async dispatchTriggerCreated(trigger: StoredCaptureTrigger): Promise<void> {
    try {
      await this.webhookDispatcher.dispatchEvent(
        WebhookEventType.MONITOR_TRIGGER_CREATED,
        {
          triggerId: trigger.id,
          metricType: trigger.metricType,
          anomalyType: trigger.anomalyType,
          expiresAt: trigger.expiresAt,
          createdAt: trigger.createdAt,
          createdBy: trigger.createdBy,
        },
        trigger.connectionId,
      );
    } catch (err) {
      this.logger.error(
        `Failed to dispatch monitor.trigger.created: ${(err as Error).message}`,
      );
    }
  }

  private async dispatchSessionSkipped(
    trigger: StoredCaptureTrigger,
    reason: string,
  ): Promise<void> {
    try {
      await this.webhookDispatcher.dispatchEvent(
        WebhookEventType.MONITOR_SESSION_SKIPPED,
        {
          triggerId: trigger.id,
          metricType: trigger.metricType,
          anomalyType: trigger.anomalyType,
          reason,
          timestamp: Date.now(),
        },
        trigger.connectionId,
      );
    } catch (err) {
      this.logger.error(
        `Failed to dispatch monitor.session.skipped: ${(err as Error).message}`,
      );
    }
  }
}
