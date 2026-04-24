import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Valkey from 'iovalkey';
import { SemanticCache } from '../SemanticCache';
import { SemanticCacheUsageError } from '../errors';
import { sha256 } from '../utils';
import { Registry } from 'prom-client';
import type { EmbedFn } from '../types';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6380';
const cacheName = `betterdb_test_${Date.now()}`;
const dim = 8;

const fakeEmbed: EmbedFn = async (text: string) => {
  const hash = sha256(text);
  const vec = Array.from({ length: dim }, (_, i) =>
    parseInt(hash.slice(i * 2, i * 2 + 2), 16) / 255,
  );
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
};

let client: Valkey;
let cache: SemanticCache;
let skip = false;
let registry: Registry;

beforeAll(async () => {
  registry = new Registry();

  // Use lazyConnect + connect() with a tight retry limit so we fail fast
  // when Valkey is not reachable instead of retrying forever.
  client = new Valkey(VALKEY_URL, {
    lazyConnect: true,
    retryStrategy: () => null, // do not retry
  });

  try {
    await client.connect();
    await client.ping();
  } catch {
    skip = true;
    // Suppress further error events from the disconnected client
    client.on('error', () => {});
    return;
  }

  cache = new SemanticCache({
    name: cacheName,
    client,
    embedFn: fakeEmbed,
    defaultThreshold: 0.1,
    uncertaintyBand: 0.05,
    telemetry: {
      registry,
    },
  });
});

afterAll(async () => {
  if (!skip && cache) {
    try {
      await cache.flush();
    } catch {
      // Ignore cleanup errors
    }
  }
  if (client) {
    client.disconnect();
  }
});

describe('SemanticCache integration', () => {
  it('initialize() creates the index; calling it twice does not throw', async () => {
    if (skip) return;
    await cache.initialize();
    // Second call should not throw
    await cache.initialize();
  });

  it('store() returns a string key matching the entry prefix', async () => {
    if (skip) return;
    const key = await cache.store('What is the capital of France?', 'Paris', {
      category: 'test',
    });
    expect(typeof key).toBe('string');
    expect(key.startsWith(`${cacheName}:entry:`)).toBe(true);
  });

  it('check() after storing same prompt returns hit with high confidence', async () => {
    if (skip) return;
    // Small delay for indexing
    await new Promise((r) => setTimeout(r, 500));

    const result = await cache.check('What is the capital of France?');
    expect(result.hit).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.response).toBe('Paris');
    expect(result.similarity).toBeDefined();
    expect(result.matchedKey).toBeDefined();
  });

  it('check() with a very different prompt returns miss with nearestMiss', async () => {
    if (skip) return;
    const result = await cache.check(
      'How do quantum computers use superposition for parallel computation?',
      { threshold: 0.01 },
    );
    expect(result.hit).toBe(false);
    expect(result.confidence).toBe('miss');
    if (result.nearestMiss) {
      expect(result.nearestMiss.similarity).toBeGreaterThan(0);
      expect(result.nearestMiss.deltaToThreshold).toBeGreaterThan(0);
    }
  });

  it('check() before initialize() throws SemanticCacheUsageError', async () => {
    if (skip) return;
    const uninitCache = new SemanticCache({
      name: `uninit_${Date.now()}`,
      client,
      embedFn: fakeEmbed,
      telemetry: { registry },
    });

    await expect(uninitCache.check('test')).rejects.toThrow(SemanticCacheUsageError);
  });

  it('store() before initialize() throws SemanticCacheUsageError', async () => {
    if (skip) return;
    const uninitCache = new SemanticCache({
      name: `uninit_${Date.now()}`,
      client,
      embedFn: fakeEmbed,
      telemetry: { registry },
    });

    await expect(uninitCache.store('test', 'test')).rejects.toThrow(
      SemanticCacheUsageError,
    );
  });

  it('stats() returns correct counts after hits and misses', async () => {
    if (skip) return;
    // Create a fresh cache with its own stats
    const statsCacheName = `betterdb_stats_test_${Date.now()}`;
    const statsCache = new SemanticCache({
      name: statsCacheName,
      client,
      embedFn: fakeEmbed,
      defaultThreshold: 0.1,
      telemetry: { registry },
    });

    try {
      await statsCache.initialize();
      await statsCache.store('Hello world', 'Hi there', { category: 'test' });

      // Wait for indexing
      await new Promise((r) => setTimeout(r, 500));

      // This should be a hit (same prompt)
      await statsCache.check('Hello world');

      // This should be a miss (very different)
      await statsCache.check('Quantum entanglement theory in physics', {
        threshold: 0.001,
      });

      const stats = await statsCache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.total).toBe(2);
      expect(stats.hitRate).toBeCloseTo(0.5, 5);
    } finally {
      await statsCache.flush();
    }
  });

  it('invalidate() deletes matching entries and reports truncation status', async () => {
    if (skip) return;
    const invCacheName = `betterdb_inv_test_${Date.now()}`;
    const invCache = new SemanticCache({
      name: invCacheName,
      client,
      embedFn: fakeEmbed,
      defaultThreshold: 0.5,
      telemetry: { registry },
    });

    try {
      await invCache.initialize();
      await invCache.store('Test invalidate prompt', 'Test response', {
        category: 'test',
      });

      // Wait for indexing
      await new Promise((r) => setTimeout(r, 500));

      const { deleted, truncated } = await invCache.invalidate('@category:{test}');
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(truncated).toBe(false);

      // Wait for index update
      await new Promise((r) => setTimeout(r, 500));

      // Subsequent check should be a miss
      const result = await invCache.check('Test invalidate prompt');
      expect(result.hit).toBe(false);
    } finally {
      await invCache.flush();
    }
  });

  it('flush() drops index; subsequent initialize() re-creates it', async () => {
    if (skip) return;
    const flushCacheName = `betterdb_flush_test_${Date.now()}`;
    const flushCache = new SemanticCache({
      name: flushCacheName,
      client,
      embedFn: fakeEmbed,
      telemetry: { registry },
    });

    await flushCache.initialize();
    await flushCache.flush();
    // Re-initializing should not throw
    await flushCache.initialize();
    await flushCache.flush();
  });

  it('indexInfo() returns valid metadata', async () => {
    if (skip) return;
    const info = await cache.indexInfo();
    expect(info.name).toBe(`${cacheName}:idx`);
    expect(info.numDocs).toBeGreaterThanOrEqual(0);
    expect(info.dimension).toBe(dim);
  });

  it('discovery: registers in __betterdb:caches and writes a heartbeat on initialize()', async () => {
    if (skip) return;
    const discoveryCacheName = `betterdb_disco_test_${Date.now()}`;
    const discoveryCache = new SemanticCache({
      name: discoveryCacheName,
      client,
      embedFn: fakeEmbed,
      telemetry: { registry },
      discovery: { heartbeatIntervalMs: 60_000 },
    });

    try {
      await discoveryCache.initialize();

      const raw = await client.hget('__betterdb:caches', discoveryCacheName);
      expect(raw).not.toBeNull();
      const marker = JSON.parse(raw ?? '{}');
      expect(marker.type).toBe('semantic_cache');
      expect(marker.prefix).toBe(discoveryCacheName);
      expect(marker.protocol_version).toBe(1);

      const protocol = await client.get('__betterdb:protocol');
      expect(protocol).toBe('1');

      const heartbeat = await client.get(`__betterdb:heartbeat:${discoveryCacheName}`);
      expect(heartbeat).not.toBeNull();
      const ttl = await client.ttl(`__betterdb:heartbeat:${discoveryCacheName}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);

      await discoveryCache.dispose();

      const afterDispose = await client.get(`__betterdb:heartbeat:${discoveryCacheName}`);
      expect(afterDispose).toBeNull();
      // Registry entry is intentionally preserved after dispose
      const registryAfter = await client.hget('__betterdb:caches', discoveryCacheName);
      expect(registryAfter).not.toBeNull();
    } finally {
      await discoveryCache.flush();
      // flush also removes the heartbeat; the registry entry is preserved, so
      // clean it up explicitly so repeated test runs don't accumulate fields.
      await client.hdel('__betterdb:caches', discoveryCacheName);
    }
  });

  it('discovery: enabled=false writes nothing to __betterdb:*', async () => {
    if (skip) return;
    const optOutName = `betterdb_disco_off_${Date.now()}`;
    const optOutCache = new SemanticCache({
      name: optOutName,
      client,
      embedFn: fakeEmbed,
      telemetry: { registry },
      discovery: { enabled: false },
    });

    try {
      await optOutCache.initialize();
      const raw = await client.hget('__betterdb:caches', optOutName);
      expect(raw).toBeNull();
      const heartbeat = await client.get(`__betterdb:heartbeat:${optOutName}`);
      expect(heartbeat).toBeNull();
    } finally {
      await optOutCache.flush();
    }
  });
});
