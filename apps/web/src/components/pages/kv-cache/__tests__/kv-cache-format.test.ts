import { describe, it, expect } from 'vitest';
import type { KvCacheFootprintSnapshot, KvCacheSampleBucket } from '@betterdb/shared';
import {
  advisoriesFor,
  evictionsPerMinute,
  formatPercent,
  modelHitRates,
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
    chunksEst: 100,
    bytesEst: 1000,
    usedMemory: 2000,
    maxmemory: 4000,
    maxmemoryPolicy: 'allkeys-lru',
    lmcacheMemoryShare: 0.5,
    noTtlRatio: 1,
    orphanRatio: 0,
    evictedKeysDelta: null,
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
  it('divides the latest delta by the minutes between the last two snapshots', () => {
    const history = [
      snapshot({ timestamp: 1_000_000, evictedKeysDelta: 5 }),
      snapshot({ timestamp: 1_000_000 + 5 * 60_000, evictedKeysDelta: 50 }),
    ];
    expect(evictionsPerMinute(history)).toBe(10);
  });

  it('rounds to one decimal', () => {
    const history = [
      snapshot({ timestamp: 0, evictedKeysDelta: 0 }),
      snapshot({ timestamp: 3 * 60_000, evictedKeysDelta: 10 }),
    ];
    expect(evictionsPerMinute(history)).toBe(3.3);
  });

  it('is null with a single snapshot', () => {
    expect(evictionsPerMinute([snapshot({ evictedKeysDelta: 5 })])).toBeNull();
  });

  it('is null when both snapshots share a timestamp', () => {
    const history = [
      snapshot({ timestamp: 60_000, evictedKeysDelta: 1 }),
      snapshot({ timestamp: 60_000, evictedKeysDelta: 5 }),
    ];
    expect(evictionsPerMinute(history)).toBeNull();
  });

  it('is null when the latest delta is null', () => {
    const history = [snapshot({ timestamp: 0 }), snapshot({ timestamp: 60_000 })];
    expect(evictionsPerMinute(history)).toBeNull();
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
