import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
import { HealthGateResult } from './health-gate';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';

/** Default trigger lifetime when caller does not specify one. Matches PRD: auto-clears in 24h. */
export const DEFAULT_TRIGGER_EXPIRY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_POLL_INTERVAL_MS = 5_000;

function triggerKey(connectionId: string, metricType: string, anomalyType: string): string {
  return JSON.stringify([connectionId, metricType, anomalyType]);
}

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
    await this.fireAll(queued);
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
    const active = await this.loadActiveTriggers();
    let maxTs = this.lastAnomalyAt;
    const matched = new Map<string, StoredCaptureTrigger>();
    for (const evt of sorted) {
      if (evt.timestamp > maxTs) {
        maxTs = evt.timestamp;
      }
      if (!evt.connectionId) {
        continue;
      }
      const match = active.get(triggerKey(evt.connectionId, evt.metricType, evt.anomalyType));
      if (match && match.status === 'configured' && evt.timestamp >= match.createdAt) {
        matched.set(match.id, match);
      }
    }
    await this.fireAll([...matched.values()]);
    this.lastAnomalyAt = maxTs;
  }

  private async loadActiveTriggers(): Promise<Map<string, StoredCaptureTrigger>> {
    const [configured, queued] = await Promise.all([
      this.storage.getCaptureTriggers({ status: 'configured' }),
      this.storage.getCaptureTriggers({ status: 'queued' }),
    ]);
    const active = new Map<string, StoredCaptureTrigger>();
    for (const trigger of [...queued, ...configured]) {
      active.set(triggerKey(trigger.connectionId, trigger.metricType, trigger.anomalyType), trigger);
    }
    return active;
  }

  private async fireAll(triggers: StoredCaptureTrigger[]): Promise<void> {
    const byConnection = new Map<string, StoredCaptureTrigger[]>();
    for (const trigger of triggers) {
      byConnection.set(trigger.connectionId, [
        ...(byConnection.get(trigger.connectionId) ?? []),
        trigger,
      ]);
    }
    const outcomes = await Promise.allSettled(
      [...byConnection.values()].map((group) => this.fireInOrder(group)),
    );
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed !== undefined) {
      throw failed.reason;
    }
  }

  private async fireInOrder(triggers: StoredCaptureTrigger[]): Promise<void> {
    for (const trigger of triggers) {
      await this.tryFire(trigger);
    }
  }

  private async evaluateGate(trigger: StoredCaptureTrigger): Promise<HealthGateResult | null> {
    try {
      return await this.healthGate.evaluate(trigger.connectionId);
    } catch (err) {
      await this.holdAfterGateFailure(trigger, err as Error);
      return null;
    }
  }

  private async holdAfterGateFailure(trigger: StoredCaptureTrigger, err: Error): Promise<void> {
    this.logger.warn(`Health gate failed for trigger ${trigger.id}: ${err.message}`);
    if (!(await this.canStillFire(trigger.id))) {
      return;
    }
    if (err instanceof NotFoundException) {
      await this.patch(trigger.id, { status: 'skipped', skipReason: 'connection_not_found' });
      void this.dispatchSessionSkipped(trigger, 'connection_not_found');
    } else if (trigger.status !== 'queued') {
      await this.patch(trigger.id, { status: 'queued' });
    }
  }

  private async tryFire(trigger: StoredCaptureTrigger): Promise<void> {
    if (this.captureService.hasActiveSessionOn(trigger.connectionId)) {
      if (trigger.status !== 'queued' && (await this.canStillFire(trigger.id))) {
        await this.patch(trigger.id, { status: 'queued' });
      }
      return;
    }
    const gate = await this.evaluateGate(trigger);
    if (gate === null || !(await this.canStillFire(trigger.id))) {
      return;
    }
    if (!gate.allow) {
      const reason = gate.skipReason ?? 'health_gate_blocked';
      await this.patch(trigger.id, { status: 'skipped', skipReason: reason });
      void this.dispatchSessionSkipped(trigger, reason);
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
      if (err instanceof ConflictException) {
        await this.patch(trigger.id, { status: 'queued' });
        return;
      }
      const message = (err as Error).message ?? 'unknown';
      this.logger.error(`Failed to start triggered session: ${message}`);
      await this.patch(trigger.id, {
        status: 'skipped',
        skipReason: `start_failed: ${message}`,
      });
    }
  }

  private async canStillFire(id: string): Promise<boolean> {
    const current = await this.storage.getCaptureTrigger(id);
    return (
      current !== null &&
      (current.status === 'configured' || current.status === 'queued') &&
      current.expiresAt > Date.now()
    );
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
