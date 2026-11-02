import { ConnectionContext } from '@app/common/services/multi-connection-poller';
import { AnomalyEvent } from './types';

export const OUTBOX_MAX_ENTRIES = 1000;
export const OUTBOX_MAX_AGE_MS = 60 * 60 * 1000;
export const OUTBOX_CLOSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_RETRY_BASE_MS = 10_000;
export const OUTBOX_RETRY_MAX_MS = 60_000;

interface RetrySchedule {
  id: string;
  enqueuedAt: number;
  attempts?: number;
  retryAt?: number;
  onDrop?: () => void;
}

export interface PendingSave extends RetrySchedule {
  kind: 'save';
  anomaly: AnomalyEvent;
  ctx?: ConnectionContext;
  rewrite?: boolean;
  onCloseDrop?: () => void;
}

export interface PendingResolve extends RetrySchedule {
  kind: 'resolve';
  resolvedAt: number;
  rowMissingSince?: number;
}

export type OutboxEntry = PendingSave | PendingResolve;
export type OutboxDropReason = 'full' | 'expired';

function closesEvent(entry: OutboxEntry): boolean {
  return entry.kind === 'resolve' || entry.anomaly.resolved;
}

function dropHook(entry: OutboxEntry): (() => void) | undefined {
  if (entry.kind === 'resolve') return entry.onDrop;
  return entry.anomaly.resolved ? entry.onCloseDrop : entry.onDrop;
}

function isExpired(entry: OutboxEntry, now: number): boolean {
  const rowMissing =
    entry.kind === 'resolve' &&
    entry.rowMissingSince !== undefined &&
    now - entry.rowMissingSince > OUTBOX_MAX_AGE_MS;
  const maxAge = closesEvent(entry) ? OUTBOX_CLOSE_MAX_AGE_MS : OUTBOX_MAX_AGE_MS;
  return rowMissing || now - entry.enqueuedAt > maxAge;
}

export class PersistenceOutbox {
  private readonly pending = new Map<string, OutboxEntry>();
  private heldDrops: PendingSave[] = [];

  constructor(private readonly onDrop: (entry: OutboxEntry, reason: OutboxDropReason) => void) {}

  get size(): number {
    return this.pending.size;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  enqueueSave(
    anomaly: AnomalyEvent,
    ctx: ConnectionContext | undefined,
    now: number,
    onDrop?: () => void,
  ): void {
    this.add({ kind: 'save', id: anomaly.id, anomaly, ctx, enqueuedAt: now, onDrop });
  }

  enqueueRewrite(anomaly: AnomalyEvent, now: number): void {
    const pendingResolve = this.pending.get(anomaly.id);
    let onCloseDrop: (() => void) | undefined;
    if (pendingResolve?.kind === 'resolve') {
      anomaly.resolved = true;
      anomaly.resolvedAt = pendingResolve.resolvedAt;
      onCloseDrop = pendingResolve.onDrop;
      this.pending.delete(anomaly.id);
    }
    this.add({ kind: 'save', id: anomaly.id, anomaly, enqueuedAt: now, rewrite: true, onCloseDrop });
  }

  enqueueResolve(id: string, resolvedAt: number, now: number, onDrop?: () => void): void {
    const existing = this.pending.get(id);
    if (existing?.kind === 'resolve') existing.onDrop ??= onDrop;
    this.add({ kind: 'resolve', id, resolvedAt, enqueuedAt: now, onDrop });
  }

  carryResolve(id: string, resolvedAt: number, onDrop?: () => void): boolean {
    const entry = this.pending.get(id);
    if (entry?.kind !== 'save') return false;
    entry.anomaly.resolved = true;
    entry.anomaly.resolvedAt = resolvedAt;
    entry.onCloseDrop = onDrop ?? entry.onCloseDrop;
    return true;
  }

  unsavedAnomaly(id: string): AnomalyEvent | undefined {
    const entry = this.pending.get(id);
    return entry?.kind === 'save' ? entry.anomaly : undefined;
  }

  resolvedAt(id: string): number | undefined {
    const entry = this.pending.get(id);
    return entry?.kind === 'resolve' ? entry.resolvedAt : undefined;
  }

  isRowMissing(id: string): boolean {
    const entry = this.pending.get(id);
    return entry?.kind === 'resolve' && entry.rowMissingSince !== undefined;
  }

  markRowMissing(id: string, now: number): void {
    const entry = this.pending.get(id);
    if (entry?.kind === 'resolve') entry.rowMissingSince ??= now;
  }

  settle(id: string): void {
    this.pending.delete(id);
  }

  settleSave(id: string): (() => void) | undefined {
    const entry = this.pending.get(id);
    if (entry?.kind !== 'save') return undefined;
    this.pending.delete(id);
    return entry.onCloseDrop;
  }

  settleResolve(id: string): void {
    if (this.pending.get(id)?.kind === 'resolve') this.pending.delete(id);
  }

  defer(id: string, now: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    const attempts = entry.attempts ?? 0;
    entry.attempts = attempts + 1;
    entry.retryAt = now + Math.min(OUTBOX_RETRY_BASE_MS * 2 ** attempts, OUTBOX_RETRY_MAX_MS);
  }

  due(now: number): OutboxEntry[] {
    for (const entry of this.pending.values()) {
      if (!isExpired(entry, now)) continue;
      this.pending.delete(entry.id);
      this.onDrop(entry, 'expired');
      dropHook(entry)?.();
    }
    this.releaseHeldDrops(now);
    return [...this.pending.values()].filter((entry) => (entry.retryAt ?? 0) <= now);
  }

  private add(entry: OutboxEntry): void {
    if (this.pending.has(entry.id)) return;
    if (this.pending.size >= OUTBOX_MAX_ENTRIES && !this.makeRoom(entry)) return;
    this.pending.set(entry.id, entry);
  }

  private makeRoom(incoming: OutboxEntry): boolean {
    const entries = [...this.pending.values()];
    const victim =
      entries.find((entry) => !closesEvent(entry)) ??
      entries.find((entry) => closesEvent(entry) && dropHook(entry) !== undefined) ??
      (closesEvent(incoming) ? entries[0] : undefined);
    if (victim) {
      this.pending.delete(victim.id);
      this.discard(victim);
      return true;
    }
    this.discard(incoming);
    return false;
  }

  private discard(entry: OutboxEntry): void {
    this.onDrop(entry, 'full');
    if (closesEvent(entry)) dropHook(entry)?.();
    else if (entry.onDrop) this.heldDrops.push(entry as PendingSave);
  }

  private releaseHeldDrops(now: number): void {
    const full = this.pending.size >= OUTBOX_MAX_ENTRIES;
    const held = this.heldDrops;
    this.heldDrops = [];
    for (const entry of held) {
      if (entry.anomaly.resolved || entry.anomaly.persisted || this.pending.has(entry.id)) continue;
      if (full && now - entry.enqueuedAt <= OUTBOX_MAX_AGE_MS) {
        this.heldDrops.push(entry);
        continue;
      }
      entry.onDrop?.();
    }
  }
}
