import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Valkey from 'iovalkey';
import { AgentCache } from '../AgentCache';
import { Registry } from 'prom-client';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6380';

let client: Valkey;
let cache: AgentCache;
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

  const cacheName = `betterdb_ac_test_${Date.now()}`;
  cache = new AgentCache({
    name: cacheName,
    client,
    defaultTtl: 300,
    tierDefaults: {
      llm: { ttl: 3600 },
      tool: { ttl: 300 },
      session: { ttl: 1800 },
    },
    costTable: {
      'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
    },
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

describe('AgentCache integration', () => {
  describe('LLM cache', () => {
    it('store and check returns hit', async () => {
      if (skip) return;

      const params = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'What is Valkey?' }],
        temperature: 0,
      };

      await cache.llm.store(params, 'Valkey is a key-value store.');

      const result = await cache.llm.check(params);
      expect(result.hit).toBe(true);
      expect(result.response).toBe('Valkey is a key-value store.');
      expect(result.tier).toBe('llm');
    });

    it('different params produce miss', async () => {
      if (skip) return;

      await cache.llm.store(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }], temperature: 0 },
        'Hi there!',
      );

      const result = await cache.llm.check({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.5, // Different temperature
      });
      expect(result.hit).toBe(false);
    });
  });

  describe('Tool cache', () => {
    it('store and check returns hit with toolName', async () => {
      if (skip) return;

      await cache.tool.store('get_weather', { city: 'Sofia' }, '{"temp": 20}');

      const result = await cache.tool.check('get_weather', { city: 'Sofia' });
      expect(result.hit).toBe(true);
      expect(result.response).toBe('{"temp": 20}');
      expect(result.tier).toBe('tool');
      expect(result.toolName).toBe('get_weather');
    });

    it('different args produce miss', async () => {
      if (skip) return;

      await cache.tool.store('get_weather', { city: 'Sofia' }, '{"temp": 20}');

      const result = await cache.tool.check('get_weather', { city: 'Berlin' });
      expect(result.hit).toBe(false);
      expect(result.toolName).toBe('get_weather');
    });

    it('per-tool policy TTL is applied', async () => {
      if (skip) return;

      await cache.tool.setPolicy('short_ttl_tool', { ttl: 1 });
      await cache.tool.store('short_ttl_tool', { id: 1 }, 'result');

      // Immediate check should hit
      const resultBefore = await cache.tool.check('short_ttl_tool', { id: 1 });
      expect(resultBefore.hit).toBe(true);

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 1500));

      // After expiry should miss
      const resultAfter = await cache.tool.check('short_ttl_tool', { id: 1 });
      expect(resultAfter.hit).toBe(false);
    });
  });

  describe('Session store', () => {
    it('set and get returns value', async () => {
      if (skip) return;

      await cache.session.set('thread-1', 'last_intent', 'book_flight');

      const value = await cache.session.get('thread-1', 'last_intent');
      expect(value).toBe('book_flight');
    });

    it('getAll returns all fields for thread', async () => {
      if (skip) return;

      await cache.session.set('thread-2', 'intent', 'search');
      await cache.session.set('thread-2', 'user_name', 'John');
      await cache.session.set('thread-2', 'step', '3');

      const all = await cache.session.getAll('thread-2');
      expect(all.intent).toBe('search');
      expect(all.user_name).toBe('John');
      expect(all.step).toBe('3');
    });

    it('destroyThread removes all fields', async () => {
      if (skip) return;

      await cache.session.set('thread-3', 'field1', 'value1');
      await cache.session.set('thread-3', 'field2', 'value2');

      const deleted = await cache.session.destroyThread('thread-3');
      expect(deleted).toBeGreaterThanOrEqual(2);

      const value = await cache.session.get('thread-3', 'field1');
      expect(value).toBeNull();
    });

    it('touch refreshes TTL', async () => {
      if (skip) return;

      // Set with 2 second TTL
      await cache.session.set('thread-4', 'field', 'value', 2);

      // Wait 1 second
      await new Promise((r) => setTimeout(r, 1000));

      // Touch to refresh TTL
      await cache.session.touch('thread-4');

      // Wait another 1.5 seconds (total 2.5s since set, but <2s since touch)
      await new Promise((r) => setTimeout(r, 1500));

      // Should still exist
      const value = await cache.session.get('thread-4', 'field');
      expect(value).toBe('value');
    });
  });

  describe('Stats', () => {
    it('stats() returns correct counts after mixed operations', async () => {
      if (skip) return;

      // Create a fresh cache to isolate stats
      const statsCacheName = `betterdb_ac_stats_${Date.now()}`;
      const statsCache = new AgentCache({
        name: statsCacheName,
        client,
        telemetry: { registry },
      });

      try {
        // LLM operations
        await statsCache.llm.store(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'Test' }] },
          'Response',
        );
        await statsCache.llm.check({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test' }],
        }); // Hit
        await statsCache.llm.check({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Different' }],
        }); // Miss

        // Tool operations
        await statsCache.tool.store('search', { q: 'test' }, 'results');
        await statsCache.tool.check('search', { q: 'test' }); // Hit
        await statsCache.tool.check('search', { q: 'other' }); // Miss

        // Session operations
        await statsCache.session.set('t1', 'k', 'v');
        await statsCache.session.get('t1', 'k');

        const stats = await statsCache.stats();

        expect(stats.llm.hits).toBe(1);
        expect(stats.llm.misses).toBe(1);
        expect(stats.llm.hitRate).toBe(0.5);

        expect(stats.tool.hits).toBe(1);
        expect(stats.tool.misses).toBe(1);
        expect(stats.tool.hitRate).toBe(0.5);

        expect(stats.session.writes).toBe(1);
        expect(stats.session.reads).toBe(1);
      } finally {
        await statsCache.flush();
      }
    });

    it('toolEffectiveness() returns per-tool rankings', async () => {
      if (skip) return;

      const effCacheName = `betterdb_ac_eff_${Date.now()}`;
      const effCache = new AgentCache({
        name: effCacheName,
        client,
        telemetry: { registry },
      });

      try {
        // Create high hit rate tool
        await effCache.tool.store('high_hit_tool', { id: 1 }, 'result', { cost: 0.01 });
        await effCache.tool.check('high_hit_tool', { id: 1 }); // Hit
        await effCache.tool.check('high_hit_tool', { id: 1 }); // Hit
        await effCache.tool.check('high_hit_tool', { id: 1 }); // Hit

        // Create low hit rate tool
        await effCache.tool.store('low_hit_tool', { id: 1 }, 'result');
        await effCache.tool.check('low_hit_tool', { id: 2 }); // Miss
        await effCache.tool.check('low_hit_tool', { id: 3 }); // Miss

        const effectiveness = await effCache.toolEffectiveness();

        expect(effectiveness.length).toBeGreaterThanOrEqual(2);

        const highHit = effectiveness.find((e) => e.tool === 'high_hit_tool');
        const lowHit = effectiveness.find((e) => e.tool === 'low_hit_tool');

        expect(highHit).toBeDefined();
        expect(lowHit).toBeDefined();
        expect(highHit!.hitRate).toBeGreaterThan(lowHit!.hitRate);
      } finally {
        await effCache.flush();
      }
    });
  });

  describe('Flush', () => {
    it('flush() removes all keys with the cache prefix', async () => {
      if (skip) return;

      const flushCacheName = `betterdb_ac_flush_${Date.now()}`;
      const flushCache = new AgentCache({
        name: flushCacheName,
        client,
        telemetry: { registry },
      });

      // Create some data
      await flushCache.llm.store(
        { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
        'world',
      );
      await flushCache.tool.store('test_tool', {}, 'result');
      await flushCache.session.set('thread', 'field', 'value');

      // Verify data exists
      const beforeStats = await flushCache.stats();
      expect(beforeStats.session.writes).toBe(1);

      // Flush
      await flushCache.flush();

      // Verify data is gone
      const afterLlm = await flushCache.llm.check({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(afterLlm.hit).toBe(false);

      const afterTool = await flushCache.tool.check('test_tool', {});
      expect(afterTool.hit).toBe(false);

      const afterSession = await flushCache.session.get('thread', 'field');
      expect(afterSession).toBeNull();
    });
  });
});
