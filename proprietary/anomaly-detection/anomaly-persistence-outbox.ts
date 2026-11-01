import { ConnectionContext } from '@app/common/services/multi-connection-poller';
import { AnomalyEvent } from './types';

export const OUTBOX_MAX_ENTRIES = 1000;
export const OUTBOX_MAX_AGE_MS = 60 * 60 * 1000;
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
}

export interface PendingResolve extends RetrySchedule {
  kind: 'resolve';
  resolvedAt: number;
}

export type OutboxEntry = PendingSave | PendingResolve;
export type OutboxDropReason = 'full' | 'expired';

function closesEvent(entry: OutboxEntry): boolean {
  return entry.kind === 'resolve' || (entry.rewrite === true && entry.anomaly.resolved);
}

export class PersistenceOutbox {
  private readonly pending = new Map<string, OutboxEntry>();
  private heldDrops: Array<() => void> = [];

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
    const resolvedAt = this.resolvedAt(anomaly.id);
    if (resolvedAt !== undefined) {
      anomaly.resolved = true;
      anomaly.resolvedAt = resolvedAt;
      this.pending.delete(anomaly.id);
    }
    this.add({ kind: 'save', id: anomaly.id, anomaly, enqueuedAt: now, rewrite: true });
  }

  enqueueResolve(id: string, resolvedAt: number, now: number, onDrop?: () => void): void {
    this.add({ kind: 'resolve', id, resolvedAt, enqueuedAt: now, onDrop });
  }

  unsavedAnomaly(id: string): AnomalyEvent | undefined {
    const entry = this.pending.get(id);
    return entry?.kind === 'save' ? entry.anomaly : undefined;
  }

  resolvedAt(id: string): number | undefined {
    const entry = this.pending.get(id);
    return entry?.kind === 'resolve' ? entry.resolvedAt : undefined;
  }

  settle(id: string): void {
    this.pending.delete(id);
  }

  settleSave(id: string): void {
    if (this.pending.get(id)?.kind === 'save') this.pending.delete(id);
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
      if (closesEvent(entry) || now - entry.enqueuedAt <= OUTBOX_MAX_AGE_MS) continue;
      this.pending.delete(entry.id);
      this.onDrop(entry, 'expired');
      entry.onDrop?.();
    }
    this.releaseHeldDrops();
    return [...this.pending.values()].filter((entry) => (entry.retryAt ?? 0) <= now);
  }

  private add(entry: OutboxEntry): void {
    if (this.pending.has(entry.id)) return;
    if (this.pending.size >= OUTBOX_MAX_ENTRIES) this.evict();
    this.pending.set(entry.id, entry);
  }

  private evict(): void {
    const entries = [...this.pending.values()];
    const victim = entries.find((entry) => !closesEvent(entry)) ?? entries[0];
    this.pending.delete(victim.id);
    this.onDrop(victim, 'full');
    if (victim.kind === 'resolve') victim.onDrop?.();
    else if (victim.onDrop) this.heldDrops.push(victim.onDrop);
  }

  private releaseHeldDrops(): void {
    if (this.pending.size >= OUTBOX_MAX_ENTRIES) return;
    const held = this.heldDrops;
    this.heldDrops = [];
    for (const onDrop of held) onDrop();
  }
}
