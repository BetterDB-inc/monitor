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
  CaptureTriggerStatus,
  StoredCaptureTrigger,
  WebhookEventType,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { HealthGateResult } from './health-gate';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';

/** Default trigger lifetime when caller does not specify one. Matches PRD: auto-clears in 24h. */
export const DEFAULT_TRIGGER_EXPIRY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const ANOMALY_PAGE_SIZE = 200;
const ACTIVE_STATUSES: readonly CaptureTriggerStatus[] = ['configured', 'queued'];

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

  cancelTrigger(id: string): Promise<boolean> {
    return this.transition(id, { status: 'cancelled' });
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
      const active = await this.sweepExpired();
      await this.fireAll(active.filter((trigger) => trigger.status === 'queued'));
      await this.processNewAnomalies(active.filter((trigger) => trigger.status === 'configured'));
    } finally {
      this.ticking = false;
    }
  }

  private async sweepExpired(): Promise<StoredCaptureTrigger[]> {
    const now = Date.now();
    const [configured, queued] = await Promise.all([
      this.storage.getCaptureTriggers({ status: 'configured' }),
      this.storage.getCaptureTriggers({ status: 'queued' }),
    ]);
    const active: StoredCaptureTrigger[] = [];
    for (const trigger of [...configured, ...queued]) {
      if (trigger.expiresAt <= now) {
        await this.transition(trigger.id, { status: 'expired' });
      } else {
        active.push(trigger);
      }
    }
    return active;
  }

  private async processNewAnomalies(configured: StoredCaptureTrigger[]): Promise<void> {
    if (configured.length === 0) {
      return;
    }
    const waiting = new Map(
      configured.map((t) => [triggerKey(t.connectionId, t.metricType, t.anomalyType), t]),
    );
    const oldestTrigger = Math.min(...configured.map((t) => t.createdAt));
    const startTime = Math.max(this.lastAnomalyAt + 1, oldestTrigger);
    let maxTs = this.lastAnomalyAt;
    const matched = new Map<string, StoredCaptureTrigger>();
    for (let offset = 0; ; offset += ANOMALY_PAGE_SIZE) {
      const page = await this.storage.getAnomalyEvents({
        startTime,
        limit: ANOMALY_PAGE_SIZE,
        offset,
      });
      for (const evt of page) {
        maxTs = Math.max(maxTs, evt.timestamp);
        const match = evt.connectionId
          ? waiting.get(triggerKey(evt.connectionId, evt.metricType, evt.anomalyType))
          : undefined;
        if (match && evt.timestamp >= match.createdAt) {
          matched.set(match.id, match);
        }
      }
      if (page.length < ANOMALY_PAGE_SIZE) {
        break;
      }
    }
    await this.fireAll([...matched.values()]);
    this.lastAnomalyAt = maxTs;
  }

  private async fireAll(triggers: StoredCaptureTrigger[]): Promise<void> {
    const byConnection = new Map<string, StoredCaptureTrigger[]>();
    for (const trigger of triggers) {
      const group = byConnection.get(trigger.connectionId);
      if (group) {
        group.push(trigger);
      } else {
        byConnection.set(trigger.connectionId, [trigger]);
      }
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
      this.logger.warn(`Health gate failed for trigger ${trigger.id}: ${(err as Error).message}`);
      await this.queue(trigger);
      return null;
    }
  }

  private async queue(trigger: StoredCaptureTrigger): Promise<void> {
    if (trigger.status !== 'queued') {
      await this.transition(trigger.id, { status: 'queued' });
    }
  }

  private async tryFire(trigger: StoredCaptureTrigger): Promise<void> {
    if (this.captureService.hasActiveSessionOn(trigger.connectionId)) {
      await this.queue(trigger);
      return;
    }
    const gate = await this.evaluateGate(trigger);
    if (gate === null || trigger.expiresAt <= Date.now()) {
      return;
    }
    if (!gate.allow) {
      const reason = gate.skipReason ?? 'health_gate_blocked';
      if (await this.transition(trigger.id, { status: 'skipped', skipReason: reason })) {
        void this.dispatchSessionSkipped(trigger, reason);
      }
      return;
    }
    if (await this.transition(trigger.id, { status: 'fired' })) {
      await this.startClaimedSession(trigger);
    }
  }

  private async startClaimedSession(trigger: StoredCaptureTrigger): Promise<void> {
    try {
      const session = await this.captureService.startSession({
        connectionId: trigger.connectionId,
        source: 'trigger',
        triggerId: trigger.id,
      });
      await this.transition(
        trigger.id,
        { firedAt: Date.now(), firedSessionId: session.id },
        ['fired'],
      );
    } catch (err) {
      if (err instanceof ConflictException || err instanceof NotFoundException) {
        await this.transition(trigger.id, { status: 'queued' }, ['fired']);
        return;
      }
      const message = (err as Error).message ?? 'unknown';
      this.logger.error(`Failed to start triggered session: ${message}`);
      await this.transition(
        trigger.id,
        { status: 'skipped', skipReason: `start_failed: ${message}` },
        ['fired'],
      );
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

  private transition(
    id: string,
    patch: CaptureTriggerPatch,
    from: readonly CaptureTriggerStatus[] = ACTIVE_STATUSES,
  ): Promise<boolean> {
    return this.storage.updateCaptureTrigger(id, patch, from);
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
