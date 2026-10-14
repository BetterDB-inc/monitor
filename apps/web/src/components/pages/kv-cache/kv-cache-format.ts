import type { KvCacheFootprintSnapshot, KvCacheSampleBucket } from '@betterdb/shared';

export type AdvisoryKind = 'unevictable' | 'orphans' | 'other_dbs';

export interface Advisory {
  kind: AdvisoryKind;
  title: string;
  body: string;
}

const UNEVICTABLE_NO_TTL_RATIO = 0.9;

export function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function advisoriesFor(snapshot: KvCacheFootprintSnapshot): Advisory[] {
  const advisories: Advisory[] = [];
  if (
    snapshot.maxmemoryPolicy.startsWith('volatile-') &&
    snapshot.noTtlRatio >= UNEVICTABLE_NO_TTL_RATIO
  ) {
    advisories.push({
      kind: 'unevictable',
      title: 'LMCache keys can never be evicted',
      body: `maxmemory-policy is ${snapshot.maxmemoryPolicy}, which only evicts keys that have a TTL, and ${formatPercent(snapshot.noTtlRatio)} of LMCache keys have none. Set valkey_enable_ttl (with valkey_ttl_sec) on the valkey:// connector, or switch to an allkeys-* maxmemory-policy.`,
    });
  }
  if (snapshot.orphanRatio !== null && snapshot.orphanRatio > 0) {
    advisories.push({
      kind: 'orphans',
      title: 'Orphaned kv_bytes keys',
      body: `${formatPercent(snapshot.orphanRatio)} of sampled kv_bytes keys have no matching metadata key. redis:// only removes them when it tries to read them.`,
    });
  }
  if (snapshot.otherDbs.length > 0) {
    advisories.push({
      kind: 'other_dbs',
      title: 'Keys in other databases',
      body: `Other databases hold keys: ${snapshot.otherDbs.map((db) => `db${db}`).join(', ')}. Only this connection's database is scanned.`,
    });
  }
  return advisories;
}

export function evictionsPerMinute(history: KvCacheFootprintSnapshot[]): number | null {
  if (history.length < 2) return null;
  const previous = history[history.length - 2];
  const last = history[history.length - 1];
  if (last.evictedKeysDelta === null) return null;
  const minutes = (last.timestamp - previous.timestamp) / 60_000;
  if (minutes <= 0) return null;
  return Math.round((last.evictedKeysDelta / minutes) * 10) / 10;
}

export function modelHitRates(buckets: KvCacheSampleBucket[]): Map<string, number | null> {
  const totals = new Map<string, { hit: number; requested: number }>();
  for (const bucket of buckets) {
    const entry = totals.get(bucket.modelName) ?? { hit: 0, requested: 0 };
    entry.hit += bucket.hitTokens;
    entry.requested += bucket.requestedTokens;
    totals.set(bucket.modelName, entry);
  }
  const rates = new Map<string, number | null>();
  for (const [model, { hit, requested }] of totals) {
    rates.set(model, requested === 0 ? null : hit / requested);
  }
  return rates;
}
