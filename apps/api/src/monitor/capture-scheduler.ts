import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { randomUUID } from 'crypto';
import {
  ScheduledCaptureQueryOptions,
  StoredScheduledCapture,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';

const INTERVAL_PREFIX = 'monitor-schedule-interval-';
const CRON_PREFIX = 'monitor-schedule-cron-';

export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60;
export const MIN_DURATION_MS = 500;
export const MAX_DURATION_MS = 15 * 60 * 1000;

export interface CreateScheduleInput {
  connectionId: string;
  /** One of intervalSeconds OR cronExpression must be supplied. */
  intervalSeconds?: number;
  cronExpression?: string;
  durationMs: number;
  createdBy?: string;
}

export interface CaptureSchedulerOptions {
  /** When false, onModuleInit does not load existing schedules. Used by tests. */
  autoStart?: boolean;
}

/**
 * Pro+ scheduled capture registry. Each enabled schedule registers a
 * setInterval-backed timer with Nest's SchedulerRegistry. On each tick the
 * scheduler:
 *   1. evaluates the health gate; on denial records the skip reason and
 *      moves on,
 *   2. attempts to start a session through MonitorCaptureService — if a
 *      session is already active on that connection, the tick is logged
 *      and skipped (single-active-session-per-instance is enforced upstream),
 *   3. records lastFiredAt / lastFiredSessionId on success.
 *
 * The scheduler is the only owner of timers; create/delete keep the timer
 * map and storage in sync.
 */
@Injectable()
export class CaptureScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptureScheduler.name);
  private autoStart = true;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly captureService: MonitorCaptureService,
    private readonly healthGate: HealthGateService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  setOptions(options: CaptureSchedulerOptions): void {
    if (options.autoStart !== undefined) {
      this.autoStart = options.autoStart;
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.autoStart) {
      return;
    }
    if (process.env.MONITOR_DEV_PREVIEW !== 'true') {
      return;
    }
    const enabled = await this.storage.getScheduledCaptures({ status: 'enabled' });
    for (const schedule of enabled) {
      this.registerTimer(schedule);
    }
    this.logger.log(`CaptureScheduler restored ${enabled.length} enabled schedule(s)`);
  }

  onModuleDestroy(): void {
    for (const name of this.activeIntervalNames()) {
      this.schedulerRegistry.deleteInterval(name);
    }
    for (const name of this.activeCronNames()) {
      this.schedulerRegistry.deleteCronJob(name);
    }
  }

  async createSchedule(input: CreateScheduleInput): Promise<StoredScheduledCapture> {
    validateScheduleSpec(input);
    validateDuration(input.durationMs);

    const schedule: StoredScheduledCapture = {
      id: randomUUID(),
      connectionId: input.connectionId,
      intervalSeconds: input.intervalSeconds,
      cronExpression: input.cronExpression,
      durationMs: input.durationMs,
      status: 'enabled',
      createdAt: Date.now(),
      createdBy: input.createdBy,
    };
    await this.storage.saveScheduledCapture(schedule);
    try {
      this.registerTimer(schedule);
    } catch (err) {
      this.logger.error(`Failed to register timer for schedule ${schedule.id}: ${(err as Error).message}`);
      await this.storage.deleteScheduledCapture(schedule.id);
      throw err;
    }
    return schedule;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const existing = await this.storage.getScheduledCapture(id);
    if (!existing) {
      throw new NotFoundException(`Schedule ${id} not found`);
    }
    this.unregisterTimer(id);
    return this.storage.deleteScheduledCapture(id);
  }

  listSchedules(
    options: ScheduledCaptureQueryOptions = {},
  ): Promise<StoredScheduledCapture[]> {
    return this.storage.getScheduledCaptures(options);
  }

  getSchedule(id: string): Promise<StoredScheduledCapture | null> {
    return this.storage.getScheduledCapture(id);
  }

  /** Test seam — fire a single tick for a schedule synchronously. */
  async fireOnce(id: string): Promise<void> {
    const schedule = await this.storage.getScheduledCapture(id);
    if (!schedule) {
      return;
    }
    await this.tick(schedule);
  }

  private registerTimer(schedule: StoredScheduledCapture): void {
    if (schedule.cronExpression) {
      this.registerCronJob(schedule);
      return;
    }
    if (schedule.intervalSeconds === undefined) {
      throw new Error(
        `Schedule ${schedule.id} has neither intervalSeconds nor cronExpression`,
      );
    }
    const name = intervalName(schedule.id);
    if (this.schedulerRegistry.doesExist('interval', name)) {
      this.schedulerRegistry.deleteInterval(name);
    }
    const handle = setInterval(() => {
      this.tick(schedule).catch((err: Error) => {
        this.logger.error(`Scheduled capture tick failed (${schedule.id}): ${err.message}`);
      });
    }, schedule.intervalSeconds * 1000);
    this.schedulerRegistry.addInterval(name, handle);
  }

  private registerCronJob(schedule: StoredScheduledCapture): void {
    const name = cronName(schedule.id);
    if (this.schedulerRegistry.doesExist('cron', name)) {
      this.schedulerRegistry.deleteCronJob(name);
    }
    const job = new CronJob(schedule.cronExpression!, () => {
      this.tick(schedule).catch((err: Error) => {
        this.logger.error(`Scheduled cron capture tick failed (${schedule.id}): ${err.message}`);
      });
    });
    this.schedulerRegistry.addCronJob(name, job);
    job.start();
  }

  private unregisterTimer(id: string): void {
    const intervalKey = intervalName(id);
    if (this.schedulerRegistry.doesExist('interval', intervalKey)) {
      this.schedulerRegistry.deleteInterval(intervalKey);
    }
    const cronKey = cronName(id);
    if (this.schedulerRegistry.doesExist('cron', cronKey)) {
      this.schedulerRegistry.deleteCronJob(cronKey);
    }
  }

  private activeIntervalNames(): string[] {
    return this.schedulerRegistry
      .getIntervals()
      .filter((n) => n.startsWith(INTERVAL_PREFIX));
  }

  private activeCronNames(): string[] {
    return Array.from(this.schedulerRegistry.getCronJobs().keys()).filter((n) =>
      n.startsWith(CRON_PREFIX),
    );
  }

  private async tick(schedule: StoredScheduledCapture): Promise<void> {
    if (this.captureService.hasActiveSessionOn(schedule.connectionId)) {
      this.logger.debug(
        `Schedule ${schedule.id} skipped: connection ${schedule.connectionId} already has an active session`,
      );
      await this.storage.updateScheduledCapture(schedule.id, {
        lastSkipReason: 'session_already_active',
      });
      return;
    }

    const gate = await this.healthGate.evaluate(schedule.connectionId);
    if (!gate.allow) {
      this.logger.debug(
        `Schedule ${schedule.id} skipped by health gate: ${gate.skipReason}`,
      );
      await this.storage.updateScheduledCapture(schedule.id, {
        lastSkipReason: gate.skipReason ?? 'health_gate_blocked',
      });
      return;
    }

    try {
      const session = await this.captureService.startSession({
        connectionId: schedule.connectionId,
        source: 'schedule',
        scheduleId: schedule.id,
        durationMs: schedule.durationMs,
      });
      await this.storage.updateScheduledCapture(schedule.id, {
        lastFiredAt: Date.now(),
        lastFiredSessionId: session.id,
        lastSkipReason: undefined,
      });
    } catch (err) {
      const message = (err as Error).message ?? 'unknown';
      this.logger.error(`Schedule ${schedule.id} start failed: ${message}`);
      await this.storage.updateScheduledCapture(schedule.id, {
        lastSkipReason: `start_failed: ${message}`,
      });
    }
  }
}

function intervalName(id: string): string {
  return `${INTERVAL_PREFIX}${id}`;
}

function cronName(id: string): string {
  return `${CRON_PREFIX}${id}`;
}

function validateScheduleSpec(input: CreateScheduleInput): void {
  const hasInterval = input.intervalSeconds !== undefined;
  const hasCron = input.cronExpression !== undefined;
  if (hasInterval === hasCron) {
    throw new BadRequestException(
      'Exactly one of intervalSeconds or cronExpression must be provided',
    );
  }
  if (hasInterval) {
    validateInterval(input.intervalSeconds!);
  } else {
    validateCron(input.cronExpression!);
  }
}

function validateInterval(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
    throw new BadRequestException(
      `intervalSeconds must be at least ${MIN_INTERVAL_SECONDS}`,
    );
  }
  if (seconds > MAX_INTERVAL_SECONDS) {
    throw new BadRequestException(
      `intervalSeconds must be at most ${MAX_INTERVAL_SECONDS}`,
    );
  }
}

function validateCron(expression: string): void {
  try {
    // CronJob constructor with start=false / no auto-run still validates the
    // expression and throws on syntax errors. We discard the instance.
    new CronJob(expression, () => undefined, null, false);
  } catch (err) {
    throw new BadRequestException(`Invalid cron expression: ${(err as Error).message}`);
  }
}

function validateDuration(ms: number): void {
  if (!Number.isFinite(ms) || ms < MIN_DURATION_MS) {
    throw new BadRequestException(`durationMs must be at least ${MIN_DURATION_MS}`);
  }
  if (ms > MAX_DURATION_MS) {
    throw new BadRequestException(`durationMs must be at most ${MAX_DURATION_MS}`);
  }
}

