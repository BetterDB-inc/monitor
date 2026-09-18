export const POLL_STALE_METRIC = 'betterdb_poll_stale';

const STALENESS_POLL_MULTIPLIER = 3;

export const STALENESS_FLOOR_MULTIPLIER = 2;

export function resolveStalenessMs(pollIntervalMs: number, configuredMs?: number): number {
  if (configuredMs !== undefined && configuredMs > 0) {
    return Math.max(configuredMs, pollIntervalMs * STALENESS_FLOOR_MULTIPLIER);
  }
  return pollIntervalMs * STALENESS_POLL_MULTIPLIER;
}

interface FreshnessEntry {
  label: string;
  lastSuccessAt: number;
}

export class FreshnessTracker {
  private readonly entries = new Map<string, FreshnessEntry>();

  constructor(private readonly boundMs: number) {}

  observe(connectionId: string, label: string, now: number): void {
    const entry = this.entries.get(connectionId);
    if (entry) {
      entry.label = label;
      return;
    }
    this.entries.set(connectionId, { label, lastSuccessAt: now });
  }

  markFresh(connectionId: string, label: string, now: number): void {
    const entry = this.entries.get(connectionId);
    if (entry === undefined) {
      return;
    }
    entry.label = label;
    entry.lastSuccessAt = now;
  }

  isStale(connectionId: string, now: number): boolean {
    const entry = this.entries.get(connectionId);
    return entry !== undefined && now - entry.lastSuccessAt > this.boundMs;
  }

  forget(connectionId: string): string | undefined {
    const entry = this.entries.get(connectionId);
    this.entries.delete(connectionId);
    return entry?.label;
  }

  hasLabel(label: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.label === label) {
        return true;
      }
    }
    return false;
  }

  labelsByFreshness(now: number): { stale: Set<string>; fresh: Set<string> } {
    const stale = new Set<string>();
    const fresh = new Set<string>();
    for (const entry of this.entries.values()) {
      if (now - entry.lastSuccessAt > this.boundMs) {
        stale.add(entry.label);
      } else {
        fresh.add(entry.label);
      }
    }
    for (const label of fresh) {
      stale.delete(label);
    }
    return { stale, fresh };
  }
}

export interface SeriesSnapshot {
  name: string;
  type: string;
  values: Array<{ labels: Record<string, string | number> }>;
}

export interface SeriesRef {
  name: string;
  labels: Record<string, string | number>;
}

export function selectSeriesToRemove(
  metrics: SeriesSnapshot[],
  connectionLabels: ReadonlySet<string>,
  excludedNames: ReadonlySet<string>,
): SeriesRef[] {
  if (connectionLabels.size === 0) {
    return [];
  }
  const refs: SeriesRef[] = [];
  for (const metric of metrics) {
    if (metric.type !== 'gauge' || excludedNames.has(metric.name)) {
      continue;
    }
    for (const value of metric.values) {
      const connection = value.labels.connection;
      if (typeof connection === 'string' && connectionLabels.has(connection)) {
        refs.push({ name: metric.name, labels: value.labels });
      }
    }
  }
  return refs;
}
