/**
 * `usageTracking: { enabled: false }` restores pre-0.14.0 hits: no usage
 * `EVAL`, and only a plain per-key `EXPIRE` when `defaultTtl` is set. The
 * default (option omitted) must keep tracking.
 */
import { describe, it, expect, vi } from 'vitest';
import { Cluster } from 'iovalkey';
import { SemanticCache } from '../SemanticCache';
import type { UsageTrackingOptions, Valkey } from '../types';

const CROSS_SLOT_ERROR =
  'All keys in the pipeline should belong to the same slots allocation group';
const KEYED_COMMANDS = [
  'hincrby',
  'hset',
  'expire',
  'zadd',
  'zrem',
  'zremrangebyscore',
  'zremrangebyrank',
] as const;
const TTL = 300;

interface QueuedCommand {
  cmd: string;
  args: unknown[];
}

interface MockOptions {
  cluster: boolean;
}

interface MockState {
  /** Commands from every pipeline whose exec() succeeded. */
  executed: QueuedCommand[];
  /** Distinct keys of every pipeline that queued a usage-tracking EVAL. */
  usagePipelines: string[][];
}

function searchReply(key: string): unknown[] {
  return ['1', key, ['__score', '0.01', 'response', `response for ${key}`]];
}

/** A usage-tracking command is `call('EVAL', script, '1', key, now, ttl)`. */
function isUsageCommand(q: QueuedCommand): boolean {
  return q.cmd === 'call' && q.args[0] === 'EVAL';
}

function keyOf(q: QueuedCommand): string | null {
  if (q.cmd === 'call') {
    return q.args[0] === 'EVAL' ? String(q.args[3]) : null;
  }
  return String(q.args[0]);
}

function makeClient(opts: MockOptions): { client: Valkey; state: MockState } {
  const state: MockState = { executed: [], usagePipelines: [] };
  let searchCount = 0;
  const nextSearchReply = (): unknown[] => searchReply(`t:entry:k${++searchCount}`);

  const pipeline = vi.fn(() => {
    const queued: QueuedCommand[] = [];
    const stub: Record<string, unknown> = {};
    for (const cmd of [...KEYED_COMMANDS, 'call']) {
      stub[cmd] = vi.fn((...args: unknown[]) => {
        queued.push({ cmd, args });
        return stub;
      });
    }
    stub.exec = vi.fn(async () => {
      const keys = [...new Set(queued.map(keyOf).filter((k): k is string => k !== null))];
      if (queued.some(isUsageCommand)) state.usagePipelines.push(keys);
      if (opts.cluster && keys.length > 1) {
        throw new Error(CROSS_SLOT_ERROR);
      }
      state.executed.push(...queued);
      return queued.map((q) => {
        if (q.cmd === 'call' && q.args[0] === 'FT.SEARCH') return [null, nextSearchReply()];
        return [null, 1];
      });
    });
    return stub;
  });

  const methods = {
    call: vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [
            ['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']],
            ['identifier', 'hit_count', 'type', 'NUMERIC'],
            ['identifier', 'last_accessed_at', 'type', 'NUMERIC'],
          ],
        ];
      }
      if (cmd === 'FT.SEARCH') return nextSearchReply();
      return 'OK';
    }),
    pipeline,
    hget: vi.fn(async () => null),
    hset: vi.fn(async () => 1),
    hgetall: vi.fn(async () => ({})),
    hincrby: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    zadd: vi.fn(async () => 1),
    zrange: vi.fn(async () => []),
    zremrangebyscore: vi.fn(async () => 0),
    nodes: vi.fn(() => []),
  };

  const client = opts.cluster
    ? (Object.assign(Object.create(Cluster.prototype) as Cluster, methods) as unknown as Valkey)
    : (methods as unknown as Valkey);
  return { client, state };
}

async function makeCache(
  client: Valkey,
  defaultTtl?: number,
  usageTracking?: UsageTrackingOptions,
) {
  const logger = { warn: vi.fn() };
  const cache = new SemanticCache({
    client,
    embedFn: async () => [0.1, 0.2],
    name: 't',
    defaultTtl,
    logger,
    embeddingCache: { enabled: false },
    discovery: { enabled: false },
    configRefresh: { enabled: false },
    usageTracking,
  });
  await cache.initialize();
  return { cache, logger };
}

/** Every usage EVAL, whether queued in a pipeline or sent via client.call. */
function usageEvals(client: Valkey, state: MockState): number {
  const call = client.call as unknown as ReturnType<typeof vi.fn>;
  const direct = call.mock.calls.filter((c) => c[0] === 'EVAL').length;
  return direct + state.executed.filter(isUsageCommand).length;
}

/** Calls to hincrby/hset on the client itself that target an entry key. */
function entryWrites(client: Valkey, method: 'hincrby' | 'hset'): unknown[][] {
  const fn = (client as unknown as Record<string, ReturnType<typeof vi.fn>>)[method];
  return fn.mock.calls.filter((c) => String(c[0]).startsWith('t:entry:'));
}

const KEYS = ['t:entry:k1', 't:entry:k2', 't:entry:k3'];
const PROMPTS = ['first', 'second', 'third'];

describe('usageTracking opt-out', () => {
  it('tracks usage by default when the option is omitted', async () => {
    const { client, state } = makeClient({ cluster: false });
    const { cache } = await makeCache(client, TTL);

    await cache.checkBatch(PROMPTS);

    expect(state.usagePipelines).toEqual([KEYS]);
    expect(state.executed.filter(isUsageCommand)).toHaveLength(3);
  });

  it('makes hits pure reads when disabled and defaultTtl is not set', async () => {
    const { client, state } = makeClient({ cluster: false });
    const { cache, logger } = await makeCache(client, undefined, { enabled: false });

    const batch = await cache.checkBatch(PROMPTS);
    const single = await cache.check('first');

    expect(batch.every((r) => r.hit)).toBe(true);
    expect(single.hit).toBe(true);
    expect(usageEvals(client, state)).toBe(0);
    expect(state.usagePipelines).toEqual([]);
    expect(client.expire).not.toHaveBeenCalled();
    expect(entryWrites(client, 'hincrby')).toEqual([]);
    expect(entryWrites(client, 'hset')).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('refreshes the TTL with one plain EXPIRE per key when disabled with defaultTtl', async () => {
    const { client, state } = makeClient({ cluster: true });
    const { cache, logger } = await makeCache(client, TTL, { enabled: false });

    const results = await cache.checkBatch(PROMPTS);

    expect(results.every((r) => r.hit)).toBe(true);
    expect(client.expire).toHaveBeenCalledTimes(3);
    for (const key of KEYS) {
      expect(client.expire).toHaveBeenCalledWith(key, TTL);
    }
    expect(usageEvals(client, state)).toBe(0);
    // No usage pipeline at all, so nothing can span slots.
    expect(state.usagePipelines).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('refreshes the TTL with one EXPIRE for a single check() when disabled', async () => {
    const { client, state } = makeClient({ cluster: false });
    const { cache } = await makeCache(client, TTL, { enabled: false });

    const result = await cache.check('first');

    expect(result.hit).toBe(true);
    expect(client.expire).toHaveBeenCalledTimes(1);
    expect(client.expire).toHaveBeenCalledWith('t:entry:k1', TTL);
    expect(usageEvals(client, state)).toBe(0);
  });

  it('rejects a non-boolean usageTracking.enabled', () => {
    const { client } = makeClient({ cluster: false });

    expect(
      () =>
        new SemanticCache({
          client,
          embedFn: async () => [0.1, 0.2],
          name: 't',
          logger: { warn: vi.fn() },
          usageTracking: { enabled: 'no' as unknown as boolean },
        }),
    ).toThrow(TypeError);
  });
});
