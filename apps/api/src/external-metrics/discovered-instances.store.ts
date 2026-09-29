import type { DiscoveredInstance } from '@betterdb/shared';
import type { InstanceKey } from './otlp-metrics-types';

export const DISCOVERED_MAX_ENTRIES = 200;
export const DISCOVERED_TTL_MS = 24 * 60 * 60 * 1000;
export const DISCOVERED_MAX_HOST_LENGTH = 253;
const MAX_NAME_LENGTH = 128;
const MAX_VERSION_LENGTH = 32;

type Details = Pick<DiscoveredInstance, 'suggestedName' | 'dbSystem' | 'version'>;

function addressKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

function describe(key: InstanceKey, attrs: Record<string, string>): Details {
  const system = attrs['db.system.name'];
  const version = attrs['redis.version'];
  return {
    suggestedName: (attrs['service.name'] || `${key.host}:${key.port}`).slice(0, MAX_NAME_LENGTH),
    ...(system === 'redis' || system === 'valkey' ? { dbSystem: system } : {}),
    ...(version ? { version: version.slice(0, MAX_VERSION_LENGTH) } : {}),
  };
}

export class DiscoveredInstancesStore {
  private readonly entries = new Map<string, DiscoveredInstance>();
  private readonly dismissed = new Map<string, number>();

  constructor(readonly enabled: boolean) {}

  record(key: InstanceKey, attrs: Record<string, string>, points: number, nowMs: number): boolean {
    if (key.host.length > DISCOVERED_MAX_HOST_LENGTH) return false;
    const id = addressKey(key.host, key.port);
    const dismissedUntil = this.dismissed.get(id);
    if (dismissedUntil !== undefined) {
      if (nowMs < dismissedUntil) return false;
      this.dismissed.delete(id);
    }
    const details = describe(key, attrs);
    const existing = this.entries.get(id);
    if (existing) {
      this.entries.set(id, {
        ...existing,
        ...details,
        lastSeenAt: nowMs,
        droppedPoints: existing.droppedPoints + points,
      });
      return false;
    }
    if (this.entries.size >= DISCOVERED_MAX_ENTRIES) this.evictLeastRecentlySeen();
    this.entries.set(id, {
      host: key.host,
      port: key.port,
      ...details,
      firstSeenAt: nowMs,
      lastSeenAt: nowMs,
      droppedPoints: points,
    });
    return true;
  }

  list(nowMs: number): DiscoveredInstance[] {
    for (const [id, entry] of this.entries) {
      if (nowMs - entry.lastSeenAt > DISCOVERED_TTL_MS) this.entries.delete(id);
    }
    for (const [id, until] of this.dismissed) {
      if (until <= nowMs) this.dismissed.delete(id);
    }
    return [...this.entries.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  dismiss(host: string, port: number, nowMs: number): void {
    const id = addressKey(host, port);
    this.entries.delete(id);
    this.dismissed.set(id, nowMs + DISCOVERED_TTL_MS);
  }

  forget(host: string, port: number): void {
    this.entries.delete(addressKey(host, port));
  }

  private evictLeastRecentlySeen(): void {
    let oldestId: string | null = null;
    let oldestSeen = Infinity;
    for (const [id, entry] of this.entries) {
      if (entry.lastSeenAt < oldestSeen) {
        oldestSeen = entry.lastSeenAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) this.entries.delete(oldestId);
  }
}
