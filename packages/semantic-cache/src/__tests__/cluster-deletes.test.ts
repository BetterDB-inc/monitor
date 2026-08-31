import { describe, it, expect, vi } from 'vitest';
import { Cluster } from 'iovalkey';
import { SemanticCache } from '../SemanticCache';
import { ValkeyCommandError } from '../errors';
import type { Valkey } from '../types';

interface PipelineStub {
  del: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

interface MockClient {
  deletedKeys: string[][];
  pipelinedKeys: string[];
  execResult: () => unknown;
  call: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  pipeline: ReturnType<typeof vi.fn>;
  hset: ReturnType<typeof vi.fn>;
  hdel: ReturnType<typeof vi.fn>;
  hget: ReturnType<typeof vi.fn>;
  hgetall: ReturnType<typeof vi.fn>;
  hincrby: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  getBuffer: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  zrange: ReturnType<typeof vi.fn>;
  nodes: ReturnType<typeof vi.fn>;
}

function makeMockClient(scannedKeys: string[], searchKeys: string[] = []): MockClient {
  const client: MockClient = {
    deletedKeys: [],
    pipelinedKeys: [],
    execResult: () => {
      return client.pipelinedKeys.map(() => {
        return [null, 1];
      });
    },
    call: vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']]],
        ];
      }
      if (cmd === 'FT.SEARCH') {
        return [String(searchKeys.length), ...searchKeys];
      }
      return 'OK';
    }),
    del: vi.fn(async (...keys: unknown[]) => {
      client.deletedKeys.push(keys.flat() as string[]);
      return 1;
    }),
    scan: vi.fn(async (cursor: string, _match: string, pattern: string) => {
      if (pattern.includes(':entry:')) {
        return ['0', scannedKeys];
      }
      return ['0', []];
    }),
    pipeline: vi.fn((): PipelineStub => {
      const stub: PipelineStub = {
        del: vi.fn((key: string) => {
          client.pipelinedKeys.push(key);
          return stub;
        }),
        exec: vi.fn(async () => {
          return client.execResult();
        }),
      };
      return stub;
    }),
    hset: vi.fn(async () => 1),
    hdel: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    hincrby: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    zrange: vi.fn(async () => []),
    nodes: vi.fn(() => null),
  };

  return client;
}

function makeCache(client: MockClient): SemanticCache {
  return new SemanticCache({
    name: 'sc_cluster_del',
    client: client as unknown as Valkey,
    embedFn: vi.fn(async () => [0.1, 0.2]),
  });
}

describe('flush() key cleanup', () => {
  it('deletes scanned keys one at a time instead of in one multi-key DEL', async () => {
    const client = makeMockClient(['sc_cluster_del:entry:a', 'sc_cluster_del:entry:b']);
    const cache = makeCache(client);

    await cache.flush();

    expect(client.pipelinedKeys).toEqual(['sc_cluster_del:entry:a', 'sc_cluster_del:entry:b']);
    for (const batch of client.deletedKeys) {
      expect(batch).toHaveLength(1);
    }
  });

  it('surfaces a per-command DEL failure instead of swallowing it', async () => {
    const client = makeMockClient(['sc_cluster_del:entry:a', 'sc_cluster_del:entry:b']);
    client.execResult = () => {
      return [
        [null, 1],
        [new Error('CROSSSLOT Keys in request don’t hash to the same slot'), null],
      ];
    };
    const cache = makeCache(client);

    await expect(cache.flush()).rejects.toBeInstanceOf(ValkeyCommandError);
  });

  it('throws when the pipeline is discarded', async () => {
    const client = makeMockClient(['sc_cluster_del:entry:a']);
    client.execResult = () => {
      return null;
    };
    const cache = makeCache(client);

    await expect(cache.flush()).rejects.toBeInstanceOf(ValkeyCommandError);
  });
});

describe('invalidate() key cleanup', () => {
  it('keeps the single multi-key DEL on a standalone client', async () => {
    const keys = ['sc_cluster_del:entry:a', 'sc_cluster_del:entry:b', 'sc_cluster_del:entry:c'];
    const client = makeMockClient([], keys);
    const cache = makeCache(client);
    await cache.initialize();

    const result = await cache.invalidate('@model:{gpt-4}');

    expect(result.deleted).toBe(3);
    expect(client.deletedKeys).toEqual([keys]);
  });

  it('issues one DEL per key on a cluster client', async () => {
    const keys = ['sc_cluster_del:entry:a', 'sc_cluster_del:entry:b', 'sc_cluster_del:entry:c'];
    const client = makeMockClient([], keys);
    const clusterClient = Object.assign(
      Object.create(Cluster.prototype) as Cluster,
      client,
    ) as unknown as Valkey;
    const cache = new SemanticCache({
      name: 'sc_cluster_del',
      client: clusterClient,
      embedFn: vi.fn(async () => [0.1, 0.2]),
    });
    await cache.initialize();

    const result = await cache.invalidate('@model:{gpt-4}');

    expect(result.deleted).toBe(3);
    expect(client.deletedKeys).toEqual([[keys[0]], [keys[1]], [keys[2]]]);
  });
});
