// NOTE: The cluster services in docker-compose.test.yml use network_mode: host,
// which only works on Linux. On macOS Docker Desktop the cluster nodes are not
// reachable from the host, so this suite skips locally and runs in CI.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Cluster } from 'iovalkey';
import type Valkey from 'iovalkey';
import { SemanticCache } from '../SemanticCache';
import { sha256 } from '../utils';
import type { EmbedFn } from '../types';

const CLUSTER_NODES = (
  process.env.VALKEY_CLUSTER_NODES ?? 'localhost:6401,localhost:6402,localhost:6403'
)
  .split(',')
  .map((hostPort) => {
    const [host, portText] = hostPort.trim().split(':');
    const port = parseInt(portText, 10);
    if (host === undefined || host === '' || Number.isNaN(port)) {
      throw new Error(`Invalid cluster node: "${hostPort}"`);
    }
    return { host, port };
  });

const dim = 8;

const fakeEmbed: EmbedFn = async (text: string) => {
  const hash = sha256(text);
  const vec = Array.from({ length: dim }, (_, i) => {
    return parseInt(hash.slice(i * 2, i * 2 + 2), 16) / 255;
  });
  const norm = Math.sqrt(
    vec.reduce((sum, value) => {
      return sum + value * value;
    }, 0),
  );
  return vec.map((value) => {
    return value / norm;
  });
};

const prompts = Array.from({ length: 24 }, (_, i) => {
  return `cluster batch prompt number ${i}`;
});

const responseFor = (prompt: string): string => {
  return `answer for ${prompt}`;
};

let client: Cluster;
let cache: SemanticCache;
let cacheName: string;
let skip = false;

beforeAll(async () => {
  client = new Cluster(CLUSTER_NODES, {
    lazyConnect: true,
    redisOptions: { retryStrategy: () => null },
  });

  try {
    await client.connect();
    await client.ping();
    await client.call('FT._LIST');
  } catch (error) {
    if (process.env.CI === 'true' && process.env.ALLOW_INTEGRATION_SKIP !== 'true') {
      throw new Error(
        `No usable cluster at ${CLUSTER_NODES.map((node) => `${node.host}:${node.port}`).join(', ')} — ` +
          `this suite cannot verify anything. Set ALLOW_INTEGRATION_SKIP=true to skip it instead. ` +
          `Cause: ${String(error)}`,
      );
    }
    skip = true;
    client.on('error', () => {});
    return;
  }

  cacheName = `betterdb_sc_cluster_${Date.now()}`;

  // FT.CREATE has no key, so a cluster client sends it to one node and the index
  // exists only there. Every master needs its own — see "Cluster mode" in the
  // package README.
  for (const node of client.nodes('master')) {
    const perNode = new SemanticCache({
      name: cacheName,
      client: node,
      embedFn: fakeEmbed,
      defaultThreshold: 0.1,
      uncertaintyBand: 0.05,
    });
    await perNode.initialize();
  }

  cache = new SemanticCache({
    name: cacheName,
    client: client as unknown as Valkey,
    embedFn: fakeEmbed,
    defaultThreshold: 0.1,
    uncertaintyBand: 0.05,
  });
  await cache.initialize();

  for (const prompt of prompts) {
    await cache.store(prompt, responseFor(prompt));
  }
});

afterAll(async () => {
  if (skip === false && client !== undefined) {
    // flush() batches a multi-key DEL, which a cluster rejects with CROSSSLOT,
    // so clean up one key at a time on each master instead.
    for (const node of client.nodes('master')) {
      const keys = await node.keys(`${cacheName}:*`);
      for (const key of keys) {
        await node.del(key);
      }
    }
  }
  if (client !== undefined) {
    client.disconnect();
  }
});

describe('SemanticCache cluster integration', () => {
  it('creates the index on every master', async () => {
    if (skip) {
      return;
    }

    for (const node of client.nodes('master')) {
      const indexes = (await node.call('FT._LIST')) as string[];
      expect(indexes).toContain(`${cacheName}:idx`);
    }
  });

  it('checkBatch pipelines FT.SEARCH across scattered keys without a cross-slot rejection', async () => {
    if (skip) {
      return;
    }

    const results = await cache.checkBatch(prompts);

    expect(results).toHaveLength(prompts.length);
    for (const result of results) {
      expect(typeof result.hit).toBe('boolean');
    }
  });

  it('never returns a response that was never stored', async () => {
    if (skip) {
      return;
    }

    const stored = new Set(
      prompts.map((prompt) => {
        return responseFor(prompt);
      }),
    );
    const results = await cache.checkBatch(prompts);

    for (const result of results) {
      if (result.hit === false) {
        continue;
      }
      expect(stored.has(String(result.response))).toBe(true);
    }
  });
});
