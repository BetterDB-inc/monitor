import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  MAX_MAINTENANCE_WINDOW_MS,
  MAX_OPEN_MAINTENANCE_WINDOWS,
  maintenanceWindowCovers,
  maintenanceWindowEffectiveEnd,
  maintenanceWindowState,
  openingEventFor,
  resolvingEventFor,
  type CreateMaintenanceWindowRequest,
  type MaintenanceWindow,
  type MaintenanceWindowState,
  type MaintenanceWindowView,
  type UpdateMaintenanceWindowRequest,
  type WebhookEventType,
} from '@betterdb/shared';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';

/** How often the in-memory copy is reloaded, so windows created on another replica apply here too. */
export const MAINTENANCE_REFRESH_INTERVAL_MS = 30_000;

/** How often ended windows are checked for alerts that are still open and must be sent now. */
export const MAINTENANCE_REPLAY_INTERVAL_MS = 15_000;

/** A window may start this far in the past (clock skew between the browser and the server). */
const START_SKEW_MS = 5 * 60_000;

/** Ended windows returned by list() when no state filter is given. */
const RECENT_ENDED_LIMIT = 20;

export type MaintenanceReplayHandler = (
  event: WebhookEventType,
  data: Record<string, unknown>,
  connectionId: string | undefined,
) => Promise<unknown>;

interface PendingOpen {
  event: WebhookEventType;
  data: Record<string, unknown>;
  connectionId: string | undefined;
  window: MaintenanceWindow;
}

/**
 * Maintenance windows silence webhook alerts during planned work.
 *
 * The dispatcher asks findSuppressing() for every event, so it reads an
 * in-memory copy and never touches storage on the hot path. Until the first
 * load succeeds it suppresses nothing: losing a page because storage was down
 * is worse than paging during maintenance.
 *
 * An opening event that was silenced (instance.down, writes.rejected,
 * failover.started) and is still unresolved when its window ends is sent
 * then, so a condition that outlives the maintenance still pages. The
 * reverse also holds: a recovery whose opener was sent before the window
 * is always sent, so a PagerDuty incident opened before the maintenance is
 * not left open by a silenced resolve.
 */
@Injectable()
export class MaintenanceWindowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceWindowService.name);
  private windows: MaintenanceWindow[] = [];
  private loaded = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private replayTimer: NodeJS.Timeout | null = null;
  private replayHandler: MaintenanceReplayHandler | null = null;
  private readonly pendingOpens = new Map<string, PendingOpen>();
  /** Openers that were sent (not silenced) and have not been resolved yet. */
  private readonly deliveredOpens = new Set<string>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    @Optional() private readonly connectionRegistry?: ConnectionRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), MAINTENANCE_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
    this.replayTimer = setInterval(() => void this.replayEnded(), MAINTENANCE_REPLAY_INTERVAL_MS);
    this.replayTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.refreshTimer = null;
    this.replayTimer = null;
  }

  /** The dispatcher registers how a held-back alert is sent once its window ends. */
  setReplayHandler(handler: MaintenanceReplayHandler): void {
    this.replayHandler = handler;
  }

  async refresh(): Promise<void> {
    try {
      this.windows = await this.storage.getMaintenanceWindowRepository().list();
      this.loaded = true;
    } catch (error) {
      this.logger.warn(
        `Failed to load maintenance windows (keeping ${this.loaded ? 'the last copy' : 'none'}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The active window that silences `event` for `connectionId`, or null.
   * When several overlap, the one that ends last, so a suppressed delivery
   * names the window that actually keeps the alert quiet. Synchronous:
   * called for every event.
   */
  findSuppressing(
    event: WebhookEventType,
    connectionId: string | undefined,
    at: number = Date.now(),
  ): MaintenanceWindow | null {
    if (!this.loaded) return null;
    let best: MaintenanceWindow | null = null;
    for (const window of this.windows) {
      if (!maintenanceWindowCovers(window, event, connectionId, at)) continue;
      if (best === null || maintenanceWindowEffectiveEnd(window) > maintenanceWindowEffectiveEnd(best)) {
        best = window;
      }
    }
    return best;
  }

  /**
   * Decide whether one event is silenced, and keep the open/resolved
   * bookkeeping exact. The dispatcher calls this once per event.
   *
   * - A silenced opener is remembered so it can be sent when the window ends.
   * - A resolver closes both lists. It is sent even inside a window when its
   *   opener was sent: suppressing that resolve would leave the incident the
   *   opener raised (PagerDuty, Opsgenie-style tools) open for good.
   */
  evaluate(
    event: WebhookEventType,
    data: Record<string, unknown>,
    connectionId: string | undefined,
    at: number,
  ): MaintenanceWindow | null {
    const window = this.findSuppressing(event, connectionId, at);

    // A resolver (instance.up, writes.recovered, failover.completed).
    const closedOpener = openingEventFor(event);
    if (closedOpener !== undefined) {
      const key = pendingKey(closedOpener, connectionId);
      const openerWasSent = this.deliveredOpens.delete(key);
      this.pendingOpens.delete(key);
      return openerWasSent ? null : window;
    }

    // An opener (instance.down, writes.rejected, failover.started).
    if (resolvingEventFor(event) !== undefined) {
      const key = pendingKey(event, connectionId);
      if (window === null) {
        this.pendingOpens.delete(key);
        this.deliveredOpens.add(key);
      } else {
        this.deliveredOpens.delete(key);
        this.pendingOpens.set(key, { event, data, connectionId, window });
      }
    }
    return window;
  }

  /** Send silenced openers whose window has ended and that no other window still covers. */
  async replayEnded(now: number = Date.now()): Promise<number> {
    if (this.replayHandler === null || this.pendingOpens.size === 0) return 0;
    let replayed = 0;
    for (const [key, pending] of [...this.pendingOpens]) {
      const current = this.windows.find((window) => window.id === pending.window.id) ?? pending.window;
      if (maintenanceWindowState(current, now) !== 'ended') continue;
      const stillCovered = this.findSuppressing(pending.event, pending.connectionId, now);
      if (stillCovered !== null) {
        pending.window = stillCovered;
        continue;
      }
      this.pendingOpens.delete(key);
      try {
        await this.replayHandler(
          pending.event,
          {
            ...pending.data,
            replayedAfterMaintenance: true,
            maintenanceWindow: {
              id: current.id,
              name: current.name,
              endedAt: maintenanceWindowEffectiveEnd(current),
            },
          },
          pending.connectionId,
        );
        replayed++;
      } catch (error) {
        this.logger.error(
          `Failed to send ${pending.event} held back by maintenance window ${current.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return replayed;
  }

  async list(state?: MaintenanceWindowState, now: number = Date.now()): Promise<MaintenanceWindowView[]> {
    const windows = await this.storage.getMaintenanceWindowRepository().list();
    const views = windows.map((window) => toView(window, now));
    if (state !== undefined) return views.filter((view) => view.state === state).sort(byStateOrder);
    const open = views.filter((view) => view.state !== 'ended');
    const ended = views
      .filter((view) => view.state === 'ended')
      .sort((a, b) => maintenanceWindowEffectiveEnd(b) - maintenanceWindowEffectiveEnd(a))
      .slice(0, RECENT_ENDED_LIMIT);
    return [...open.sort(byStateOrder), ...ended];
  }

  async get(id: string, now: number = Date.now()): Promise<MaintenanceWindowView> {
    return toView(await this.require(id), now);
  }

  async create(
    input: CreateMaintenanceWindowRequest,
    createdBy: string | null,
    now: number = Date.now(),
  ): Promise<MaintenanceWindowView> {
    const startsAt = input.startsAt ?? now;
    if (startsAt < now - START_SKEW_MS) {
      throw new BadRequestException('startsAt cannot be in the past');
    }
    validateRange(startsAt, input.endsAt);
    const connectionId = input.connectionId ?? null;
    if (connectionId !== null && this.connectionRegistry !== undefined) {
      if (this.connectionRegistry.getConfig(connectionId) === null) {
        throw new BadRequestException(`Connection '${connectionId}' not found`);
      }
    }

    const repo = this.storage.getMaintenanceWindowRepository();
    const open = (await repo.list()).filter((window) => maintenanceWindowState(window, now) !== 'ended');
    if (open.length >= MAX_OPEN_MAINTENANCE_WINDOWS) {
      throw new BadRequestException(
        `At most ${MAX_OPEN_MAINTENANCE_WINDOWS} scheduled or active maintenance windows are allowed`,
      );
    }

    const window: MaintenanceWindow = {
      id: randomUUID(),
      name: input.name.trim(),
      reason: normalizeReason(input.reason),
      connectionId,
      events: dedupe(input.events ?? []),
      startsAt,
      endsAt: input.endsAt,
      endedAt: null,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await repo.save(window);
    await this.refresh();
    this.logger.log(
      `Maintenance window ${window.id} "${window.name}" scheduled ${new Date(startsAt).toISOString()} - ${new Date(window.endsAt).toISOString()} for ${connectionId ?? 'all connections'}`,
    );
    return toView(window, now);
  }

  async update(
    id: string,
    patch: UpdateMaintenanceWindowRequest,
    now: number = Date.now(),
  ): Promise<MaintenanceWindowView> {
    const existing = await this.require(id);
    const state = maintenanceWindowState(existing, now);
    if (state === 'ended') {
      throw new ConflictException('An ended maintenance window cannot be changed');
    }
    if (patch.startsAt !== undefined && state !== 'scheduled') {
      throw new BadRequestException('startsAt can only change before the window starts');
    }
    if (patch.startsAt !== undefined && patch.startsAt < now - START_SKEW_MS) {
      throw new BadRequestException('startsAt cannot be in the past');
    }

    const updated: MaintenanceWindow = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      reason: patch.reason !== undefined ? normalizeReason(patch.reason) : existing.reason,
      events: patch.events !== undefined ? dedupe(patch.events) : existing.events,
      startsAt: patch.startsAt ?? existing.startsAt,
      endsAt: patch.endsAt ?? existing.endsAt,
      updatedAt: now,
    };
    validateRange(updated.startsAt, updated.endsAt);
    if (updated.endsAt <= now) {
      throw new BadRequestException('endsAt must be in the future; use POST /maintenance-windows/:id/end to end it now');
    }

    await this.storage.getMaintenanceWindowRepository().save(updated);
    await this.refresh();
    return toView(updated, now);
  }

  /** End an active window now, or cancel a scheduled one. */
  async end(id: string, now: number = Date.now()): Promise<MaintenanceWindowView> {
    const existing = await this.require(id);
    if (maintenanceWindowState(existing, now) === 'ended') {
      throw new ConflictException('Maintenance window has already ended');
    }
    const ended: MaintenanceWindow = { ...existing, endedAt: now, updatedAt: now };
    await this.storage.getMaintenanceWindowRepository().save(ended);
    await this.refresh();
    await this.replayEnded(now);
    this.logger.log(`Maintenance window ${id} "${existing.name}" ended early`);
    return toView(ended, now);
  }

  async delete(id: string, now: number = Date.now()): Promise<void> {
    const existing = await this.require(id);
    const deleted = await this.storage.getMaintenanceWindowRepository().delete(id);
    if (!deleted) throw new NotFoundException(`Maintenance window ${id} not found`);
    // Deleting an active window ends it: held-back openers must still go out.
    const asEnded = { ...existing, endedAt: Math.min(existing.endedAt ?? now, now) };
    for (const pending of this.pendingOpens.values()) {
      if (pending.window.id === id) pending.window = asEnded;
    }
    await this.refresh();
    await this.replayEnded(now);
  }

  /** Held-back openers, for tests and diagnostics. */
  pendingReplayCount(): number {
    return this.pendingOpens.size;
  }

  private async require(id: string): Promise<MaintenanceWindow> {
    const window = await this.storage.getMaintenanceWindowRepository().get(id);
    if (window === null) throw new NotFoundException(`Maintenance window ${id} not found`);
    return window;
  }
}

function pendingKey(event: WebhookEventType, connectionId: string | undefined): string {
  return `${connectionId ?? ''}|${event}`;
}

function validateRange(startsAt: number, endsAt: number): void {
  if (!(endsAt > startsAt)) {
    throw new BadRequestException('endsAt must be after startsAt');
  }
  if (endsAt - startsAt > MAX_MAINTENANCE_WINDOW_MS) {
    throw new BadRequestException('A maintenance window can last at most 7 days');
  }
}

function normalizeReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  const trimmed = reason.trim();
  return trimmed === '' ? null : trimmed;
}

function dedupe(events: WebhookEventType[]): WebhookEventType[] {
  return [...new Set(events)];
}

function toView(window: MaintenanceWindow, now: number): MaintenanceWindowView {
  return { ...window, state: maintenanceWindowState(window, now) };
}

const STATE_ORDER: Record<MaintenanceWindowState, number> = { active: 0, scheduled: 1, ended: 2 };

function byStateOrder(a: MaintenanceWindowView, b: MaintenanceWindowView): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.startsAt - b.startsAt;
}
