import type { WebhookEventType } from '../webhooks/types';

/**
 * A planned period (failover drill, migration cutover, rolling restart,
 * config change) during which webhook alerts are recorded but not sent.
 */
export interface MaintenanceWindow {
  id: string;
  name: string;
  reason: string | null;
  /** Connection the window applies to; null covers every connection (and global events). */
  connectionId: string | null;
  /** Events the window silences; empty silences every event. */
  events: WebhookEventType[];
  /** Epoch ms, inclusive. */
  startsAt: number;
  /** Epoch ms, exclusive. */
  endsAt: number;
  /** Epoch ms the window was ended early (or cancelled before it started); null otherwise. */
  endedAt: number | null;
  /** Email of the member who created it, when workspace auth is on. */
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MaintenanceWindowState = 'scheduled' | 'active' | 'ended';

export interface MaintenanceWindowView extends MaintenanceWindow {
  state: MaintenanceWindowState;
}

export interface CreateMaintenanceWindowRequest {
  name: string;
  reason?: string | null;
  connectionId?: string | null;
  events?: WebhookEventType[];
  /** Defaults to now. */
  startsAt?: number;
  endsAt: number;
}

export interface UpdateMaintenanceWindowRequest {
  name?: string;
  reason?: string | null;
  events?: WebhookEventType[];
  /** Only while the window is still scheduled. */
  startsAt?: number;
  endsAt?: number;
}

/** A window can silence alerts for at most a week; a forgotten window must not mute paging forever. */
export const MAX_MAINTENANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Scheduled + active windows allowed at once, so evaluating them per event stays trivial. */
export const MAX_OPEN_MAINTENANCE_WINDOWS = 100;

/** When the window stops silencing: endsAt, or earlier if it was ended by hand. */
export function maintenanceWindowEffectiveEnd(window: Pick<MaintenanceWindow, 'endsAt' | 'endedAt'>): number {
  return window.endedAt === null ? window.endsAt : Math.min(window.endsAt, window.endedAt);
}

export function maintenanceWindowState(
  window: Pick<MaintenanceWindow, 'startsAt' | 'endsAt' | 'endedAt'>,
  now: number,
): MaintenanceWindowState {
  if (now >= maintenanceWindowEffectiveEnd(window)) return 'ended';
  if (now < window.startsAt) return 'scheduled';
  return 'active';
}

/**
 * Whether `window` silences `event` for `connectionId` at `at`. A global
 * event (no connection) is only silenced by an all-connections window.
 */
export function maintenanceWindowCovers(
  window: MaintenanceWindow,
  event: WebhookEventType,
  connectionId: string | undefined,
  at: number,
): boolean {
  if (maintenanceWindowState(window, at) !== 'active') return false;
  if (window.connectionId !== null && window.connectionId !== connectionId) return false;
  return window.events.length === 0 || window.events.includes(event);
}
