import { ConnectionContext } from '@app/common/services/multi-connection-poller';
import { AnomalyEvent } from './types';

export const OUTBOX_MAX_ENTRIES = 1000;
export const OUTBOX_MAX_AGE_MS = 60 * 60 * 1000;

export interface PendingSave {
  kind: 'save';
  id: string;
  anomaly: AnomalyEvent;
  ctx?: ConnectionContext;
  enqueuedAt: number;
}

export interface PendingResolve {
  kind: 'resolve';
  id: string;
  resolvedAt: number;
  enqueuedAt: number;
}

export type OutboxEntry = PendingSave | PendingResolve;
export type OutboxDropReason = 'full' | 'expired';

export class PersistenceOutbox {
  private readonly pending = new Map<string, OutboxEntry>();

  constructor(private readonly onDrop: (entry: OutboxEntry, reason: OutboxDropReason) => void) {}

  get size(): number {
    return this.pending.size;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  enqueueSave(anomaly: AnomalyEvent, ctx: ConnectionContext | undefined, now: number): void {
    this.add({ kind: 'save', id: anomaly.id, anomaly, ctx, enqueuedAt: now });
  }

  enqueueResolve(id: string, resolvedAt: number, now: number): void {
    this.add({ kind: 'resolve', id, resolvedAt, enqueuedAt: now });
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

  due(now: number): OutboxEntry[] {
    for (const entry of this.pending.values()) {
      if (now - entry.enqueuedAt <= OUTBOX_MAX_AGE_MS) continue;
      this.pending.delete(entry.id);
      this.onDrop(entry, 'expired');
    }
    return [...this.pending.values()];
  }

  private add(entry: OutboxEntry): void {
    if (this.pending.has(entry.id)) return;
    if (this.pending.size >= OUTBOX_MAX_ENTRIES) {
      const oldest = this.pending.values().next().value as OutboxEntry;
      this.pending.delete(oldest.id);
      this.onDrop(oldest, 'full');
    }
    this.pending.set(entry.id, entry);
  }
}
