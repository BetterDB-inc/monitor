import { describe, it, expect } from 'vitest';
import type { KvCacheFootprintSnapshot, KvCacheSampleBucket } from '@betterdb/shared';
import {
  advisoriesFor,
  chartTimeFormatter,
  evictionsPerMinute,
  formatPercent,
  modelHitRates,
  samplesStartedAfter,
} from '../kv-cache-format';

function snapshot(overrides: Partial<KvCacheFootprintSnapshot> = {}): KvCacheFootprintSnapshot {
  return {
    connectionId: 'c1',
    timestamp: 0,
    detected: true,
    layout: 'two_key',
    scannedKeys: 100,
    matchedKeys: 100,
    sampledKeys: 10,
    scanComplete: true,
    primariesScanned: 1,
    primariesTotal: 1,
    chunksEst: 100,
    bytesEst: 1000,
    usedMemory: 2000,
    maxmemory: 4000,
    maxmemoryPolicy: 'allkeys-lru',
    lmcacheMemoryShare: 0.5,
    noTtlRatio: 1,
    orphanRatio: 0,
    evictedKeysDelta: null,
    evictedKeysIntervalMs: null,
    otherDbs: [],
    perModel: [],
    ...overrides,
  };
}

function bucket(modelName: string, requestedTokens: number, hitTokens: number): KvCacheSampleBucket {
  return {
    engineId: 'e1',
    connectionId: 'c1',
    modelName,
    timestamp: 0,
    requestedTokens,
    hitTokens,
    lookupTokens: 0,
    lookupHits: 0,
    remoteReadBytes: 0,
    remoteWriteBytes: 0,
    remoteReadRequests: 0,
    remoteWriteRequests: 0,
    remotePingErrors: 0,
    hitRate: null,
  };
}

describe('advisoriesFor', () => {
  it('returns nothing for allkeys-lru without TTLs', () => {
    expect(advisoriesFor(snapshot())).toEqual([]);
  });

  it('flags unevictable keys for a volatile policy with no TTLs', () => {
    const result = advisoriesFor(snapshot({ maxmemoryPolicy: 'volatile-ttl', noTtlRatio: 0.95 }));
    expect(result.map((a) => a.kind)).toEqual(['unevictable']);
    expect(result[0].title).toBe('LMCache keys can never be evicted');
    expect(result[0].body).toContain('volatile-ttl');
    expect(result[0].body).toContain('valkey_enable_ttl');
    expect(result[0].body).toContain('valkey_ttl_sec');
  });

  it('does not flag unevictable keys when LMCache is not detected', () => {
    expect(
      advisoriesFor(snapshot({ detected: false, maxmemoryPolicy: 'volatile-lru', noTtlRatio: 1 })),
    ).toEqual([]);
  });

  it('flags the exact 0.9 no-TTL boundary and not 0.89', () => {
    expect(
      advisoriesFor(snapshot({ maxmemoryPolicy: 'volatile-lru', noTtlRatio: 0.9 })).map(
        (a) => a.kind,
      ),
    ).toEqual(['unevictable']);
    expect(advisoriesFor(snapshot({ maxmemoryPolicy: 'volatile-lru', noTtlRatio: 0.89 }))).toEqual(
      [],
    );
  });

  it('does not flag a volatile policy without TTL data', () => {
    expect(advisoriesFor(snapshot({ maxmemoryPolicy: 'volatile-lru', noTtlRatio: null }))).toEqual(
      [],
    );
  });

  it('does not flag a volatile policy below the no-TTL threshold', () => {
    expect(advisoriesFor(snapshot({ maxmemoryPolicy: 'volatile-lru', noTtlRatio: 0.5 }))).toEqual(
      [],
    );
  });

  it('reports orphaned kv_bytes keys only when the ratio is positive', () => {
    expect(advisoriesFor(snapshot({ orphanRatio: 0 }))).toEqual([]);
    expect(advisoriesFor(snapshot({ orphanRatio: null }))).toEqual([]);
    const result = advisoriesFor(snapshot({ orphanRatio: 0.125 }));
    expect(result.map((a) => a.kind)).toEqual(['orphans']);
    expect(result[0].title).toBe('Orphaned kv_bytes keys');
    expect(result[0].body).toContain('12.5%');
  });

  it('lists other databases that hold keys', () => {
    const result = advisoriesFor(snapshot({ otherDbs: [3, 5] }));
    expect(result.map((a) => a.kind)).toEqual(['other_dbs']);
    expect(result[0].title).toBe('Keys in other databases');
    expect(result[0].body).toContain('db3, db5');
  });
});

describe('evictionsPerMinute', () => {
  it('divides the latest delta by the interval it covers, not the gap to the previous point', () => {
    const history = [
      snapshot({ timestamp: 1_000_000, evictedKeysDelta: 5, evictedKeysIntervalMs: 60_000 }),
      snapshot({ timestamp: 1_000_000 + 60 * 60_000, evictedKeysDelta: 50, evictedKeysIntervalMs: 5 * 60_000 }),
    ];
    expect(evictionsPerMinute(history)).toBe(10);
  });

  it('rounds to one decimal', () => {
    expect(evictionsPerMinute([snapshot({ evictedKeysDelta: 10, evictedKeysIntervalMs: 3 * 60_000 })])).toBe(3.3);
  });

  it('is null without snapshots', () => {
    expect(evictionsPerMinute([])).toBeNull();
  });

  it('is null when the interval is unknown or zero', () => {
    expect(evictionsPerMinute([snapshot({ evictedKeysDelta: 5, evictedKeysIntervalMs: null })])).toBeNull();
    expect(evictionsPerMinute([snapshot({ evictedKeysDelta: 5, evictedKeysIntervalMs: 0 })])).toBeNull();
  });

  it('is null when the latest delta is null', () => {
    expect(evictionsPerMinute([snapshot({ evictedKeysIntervalMs: 60_000 })])).toBeNull();
  });
});

describe('modelHitRates', () => {
  it('sums hits over requested tokens per model', () => {
    const rates = modelHitRates([bucket('a', 100, 20), bucket('a', 100, 60), bucket('b', 50, 5)]);
    expect(rates.get('a')).toBe(0.4);
    expect(rates.get('b')).toBe(0.1);
  });

  it('is null when nothing was requested', () => {
    expect(modelHitRates([bucket('a', 0, 0)]).get('a')).toBeNull();
  });
});

describe('formatPercent', () => {
  it('formats a ratio with one decimal', () => {
    expect(formatPercent(0.7)).toBe('70.0%');
  });

  it('renders a dash for null', () => {
    expect(formatPercent(null)).toBe('—');
  });
});

describe('samplesStartedAfter', () => {
  const at = (timestamp: number) => ({ timestamp }) as KvCacheSampleBucket;

  it('returns the first bucket when it starts more than a bucket after from', () => {
    expect(samplesStartedAfter([at(500_000), at(200_000)], 0)).toBe(200_000);
  });

  it('returns null when data covers the start of the range', () => {
    expect(samplesStartedAfter([at(60_000), at(120_000)], 0)).toBeNull();
  });

  it('returns null without buckets', () => {
    expect(samplesStartedAfter([], 0)).toBeNull();
  });
});

describe('chartTimeFormatter', () => {
  const t = Date.UTC(2026, 9, 21, 12, 30);
  const day = 24 * 60 * 60 * 1000;

  it('shows only the time for ranges up to a day', () => {
    expect(chartTimeFormatter(day)(t)).toBe(
      new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('adds the date for ranges longer than a day', () => {
    const label = chartTimeFormatter(3 * day)(t);
    expect(label).toContain(new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  });
});
