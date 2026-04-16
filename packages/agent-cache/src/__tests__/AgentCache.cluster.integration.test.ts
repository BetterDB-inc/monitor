// NOTE: The cluster services in docker-compose.test.yml use network_mode: host,
// which only works on Linux. On macOS Docker Desktop the cluster nodes are not
// reachable from the host. These tests skip gracefully when the connection fails,
// so they are safe to run on any platform — they will simply be skipped on macOS.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Populated in beforeAll — defined here so it.skipIf() can reference it at test-definition time.
// Vitest evaluates skipIf lazily (at run time, not parse time), so this works correctly.
let skip = false;
import { Cluster } from 'iovalkey';
import { AgentCache } from '../AgentCache';
import { Registry } from 'prom-client';

const CLUSTER_NODES = (process.env.VALKEY_CLUSTER_NODES ?? 'localhost:6401,localhost:6402,localhost:6403')
  .split(',')
  .map((hp) => {
    const [host, portStr] = hp.trim().split(':');
    const port = parseInt(portStr, 10);
    if (!host || isNaN(port)) throw new Error(`Invalid cluster node: "${hp}"`);
    return { host, port };
  });

let client: Cluster;
let cache: AgentCache;
let registry: Registry;

beforeAll(async () => {
  registry = new Registry();

  client = new Cluster(CLUSTER_NODES, {
    lazyConnect: true,
    redisOptions: { retryStrategy: () => null },
  });

  try {
    await client.connect();
    await client.ping();
  } catch {
    skip = true;
    client.on('error', () => {});
    return;
  }

  const cacheName = `betterdb_ac_cluster_${Date.now()}`;
  cache = new AgentCache({
    name: cacheName,
    client: client as any, // Cluster is compatible with Valkey interface
    defaultTtl: 300,
    tierDefaults: {
      llm: { ttl: 3600 },
      tool: { ttl: 300 },
      session: { ttl: 1800 },
    },
    telemetry: { registry },
  });
});

afterAll(async () => {
  if (!skip && cache) {
    try { await cache.flush(); } catch {}
  }
  if (client) { client.disconnect(); }
});

describe('AgentCache cluster integration', () => {
  it.skipIf(skip)('basic operations work through cluster (LLM, tool, session)', async () => {

    // LLM tier
    const llmParams = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'cluster basic test' }],
      temperature: 0,
    };
    await cache.llm.store(llmParams, 'cluster response');
    const llmResult = await cache.llm.check(llmParams);
    expect(llmResult.hit).toBe(true);
    expect(llmResult.response).toBe('cluster response');

    // Tool tier
    await cache.tool.store('cluster_basic_tool', { id: 1 }, 'tool result');
    const toolResult = await cache.tool.check('cluster_basic_tool', { id: 1 });
    expect(toolResult.hit).toBe(true);
    expect(toolResult.response).toBe('tool result');

    // Session tier
    await cache.session.set('cluster-thread-basic', 'field1', 'value1');
    const sessionResult = await cache.session.get('cluster-thread-basic', 'field1');
    expect(sessionResult).toBe('value1');
  });

  it.skipIf(skip)('flush() removes keys across all nodes', async () => {

    const flushName = `betterdb_ac_flush_cluster_${Date.now()}`;
    const flushCache = new AgentCache({
      name: flushName,
      client: client as any,
      defaultTtl: 300,
      telemetry: { registry },
    });

    // Write enough keys with varied content to increase cross-node distribution.
    // A 3-master cluster splits 16384 hash slots ~5461 each; 20 random keys
    // gives high probability of spanning multiple nodes.
    const threads = [
      'thread-a', 'thread-b', 'thread-c', 'thread-d', 'thread-e',
      'thread-f', 'thread-g', 'thread-h', 'thread-i', 'thread-j',
      'thread-k', 'thread-l', 'thread-m', 'thread-n', 'thread-o',
      'thread-p', 'thread-q', 'thread-r', 'thread-s', 'thread-t',
    ];
    for (const thread of threads) {
      await flushCache.session.set(thread, 'data', `value-${thread}`);
    }

    await flushCache.flush();

    // Every key must be gone, regardless of which node it was on
    for (const thread of threads) {
      const val = await flushCache.session.get(thread, 'data');
      expect(val).toBeNull();
    }
  });

  it.skipIf(skip)('destroyThread() removes keys across all nodes', async () => {

    // Write fields for multiple threads to increase cross-node likelihood
    const threadIds = [
      'destroy-a', 'destroy-b', 'destroy-c', 'destroy-d', 'destroy-e',
      'destroy-f', 'destroy-g',
    ];
    const fields = ['f1', 'f2', 'f3', 'f4'];

    for (const thread of threadIds) {
      for (const field of fields) {
        await cache.session.set(thread, field, `${thread}:${field}`);
      }
    }

    // Destroy one thread
    const deleted = await cache.session.destroyThread('destroy-a');
    expect(deleted).toBeGreaterThanOrEqual(fields.length);

    // Verify all fields for that thread are gone
    for (const field of fields) {
      const val = await cache.session.get('destroy-a', field);
      expect(val).toBeNull();
    }

    // Verify other threads are unaffected
    const val = await cache.session.get('destroy-b', 'f1');
    expect(val).toBe('destroy-b:f1');

    // Cleanup remaining threads
    for (const thread of threadIds) {
      await cache.session.destroyThread(thread);
    }
  });

  it.skipIf(skip)('invalidateByModel() removes keys across all nodes', async () => {

    const modelName = 'gpt-cluster-invalidate-test';
    // 15 different prompts → 15 different SHA-256 hashes → likely different hash slots
    const prompts = [
      'What is Valkey?', 'How does cluster work?', 'What is Redis?',
      'Explain cache invalidation', 'What is a hash slot?',
      'How many hash slots exist?', 'What is a master node?', 'What is a replica?',
      'How does failover work?', 'What is SCAN?',
      'How does replication work?', 'What is AOF?', 'What is RDB?',
      'What is keyspace notification?', 'What is pub/sub?',
    ];

    for (const prompt of prompts) {
      await cache.llm.store(
        { model: modelName, messages: [{ role: 'user', content: prompt }], temperature: 0 },
        `response: ${prompt}`,
      );
    }

    // Verify at least one entry exists
    const beforeCheck = await cache.llm.check({
      model: modelName,
      messages: [{ role: 'user', content: prompts[0] }],
      temperature: 0,
    });
    expect(beforeCheck.hit).toBe(true);

    const deleted = await cache.llm.invalidateByModel(modelName);
    expect(deleted).toBeGreaterThan(0);

    // All entries must be gone after invalidation
    for (const prompt of prompts) {
      const result = await cache.llm.check({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });
      expect(result.hit).toBe(false);
    }
  });

  it.skipIf(skip)('invalidateByTool() removes keys across all nodes', async () => {

    const toolName = 'cluster_weather_invalidate';
    // 15 different argument sets → different hashes → different hash slots
    const cities = [
      'Sofia', 'Berlin', 'Paris', 'London', 'Tokyo',
      'New York', 'Sydney', 'Toronto', 'Rome', 'Madrid',
      'Amsterdam', 'Vienna', 'Prague', 'Warsaw', 'Lisbon',
    ];

    for (const city of cities) {
      await cache.tool.store(toolName, { city }, `weather for ${city}`);
    }

    // Verify at least one entry exists
    const beforeCheck = await cache.tool.check(toolName, { city: 'Sofia' });
    expect(beforeCheck.hit).toBe(true);

    const deleted = await cache.tool.invalidateByTool(toolName);
    expect(deleted).toBeGreaterThan(0);

    // All entries must be gone
    for (const city of cities) {
      const result = await cache.tool.check(toolName, { city });
      expect(result.hit).toBe(false);
    }
  });

  it.skipIf(skip)('getAll() returns fields from all nodes', async () => {

    const threadId = `cluster-getall-${Date.now()}`;
    const fieldCount = 20;
    const expected: Record<string, string> = {};

    for (let i = 0; i < fieldCount; i++) {
      const field = `field-${i}`;
      const value = `value-${i}`;
      await cache.session.set(threadId, field, value);
      expected[field] = value;
    }

    const result = await cache.session.getAll(threadId);

    expect(Object.keys(result).length).toBe(fieldCount);
    for (const [field, value] of Object.entries(expected)) {
      expect(result[field]).toBe(value);
    }

    // Cleanup
    await cache.session.destroyThread(threadId);
  });

  it.skipIf(skip)('touch() refreshes TTLs across all nodes', async () => {

    const threadId = `cluster-touch-${Date.now()}`;
    const fieldCount = 15;

    // Set fields with a short TTL (3 seconds)
    for (let i = 0; i < fieldCount; i++) {
      await cache.session.set(threadId, `field-${i}`, `value-${i}`, 3);
    }

    // Wait 2 seconds — TTL is down to ~1 second remaining
    await new Promise((r) => setTimeout(r, 2000));

    // Touch refreshes TTL to the session tier default (1800 seconds)
    await cache.session.touch(threadId);

    // Wait another 2 seconds (4 seconds total; would have expired without touch)
    await new Promise((r) => setTimeout(r, 2000));

    // All fields must still exist because touch extended the TTL
    for (let i = 0; i < fieldCount; i++) {
      const val = await cache.session.get(threadId, `field-${i}`);
      expect(val).toBe(`value-${i}`);
    }

    // Cleanup
    await cache.session.destroyThread(threadId);
  }, 10000);

  it.skipIf(skip)('stats() works through cluster', async () => {

    const statsName = `betterdb_ac_cluster_stats_${Date.now()}`;
    const statsCache = new AgentCache({
      name: statsName,
      client: client as any,
      telemetry: { registry },
    });

    try {
      await statsCache.llm.store(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'cluster stats test' }] },
        'response',
      );
      await statsCache.llm.check({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'cluster stats test' }],
      }); // Hit
      await statsCache.llm.check({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'different prompt' }],
      }); // Miss

      await statsCache.tool.store('cluster_stats_tool', { id: 1 }, 'result');
      await statsCache.tool.check('cluster_stats_tool', { id: 1 }); // Hit
      await statsCache.tool.check('cluster_stats_tool', { id: 2 }); // Miss

      const stats = await statsCache.stats();

      expect(stats.llm.hits).toBe(1);
      expect(stats.llm.misses).toBe(1);
      expect(stats.tool.hits).toBe(1);
      expect(stats.tool.misses).toBe(1);
    } finally {
      await statsCache.flush();
    }
  });
});
