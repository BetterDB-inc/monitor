/**
 * Per-entry usage tracking must survive Valkey Cluster. Each hit now runs a
 * single-key `EVAL` of the usage script (guarded by `EXISTS`, so it never
 * resurrects a deleted/expired entry); entry keys carry no hash tag, so a
 * single pipeline spanning several matched keys is rejected by iovalkey's
 * Cluster client and each key must get its own pipeline.
 */
import { describe, it, expect, vi } from 'vitest';
import { Cluster } from 'iovalkey';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

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
  /** exec() rejects for any usage pipeline touching this key. */
  failKey?: string;
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

/**
 * The hash-slot key of a queued command. For a usage EVAL it's the single key
 * at args[3]; for an FT.SEARCH call there's no slot key; otherwise it's args[0].
 */
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
      const isUsage = queued.some(isUsageCommand);
      if (isUsage) state.usagePipelines.push(keys);
      if (opts.cluster && keys.length > 1) {
        throw new Error(CROSS_SLOT_ERROR);
      }
      if (isUsage && opts.failKey !== undefined && keys.includes(opts.failKey)) {
        throw new Error('connection lost');
      }
      state.executed.push(...queued);
      return queued.map((q) => {
        if (q.cmd === 'call' && q.args[0] === 'FT.SEARCH') return [null, nextSearchReply()];
        if (isUsageCommand(q)) return [null, 1];
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

async function makeCache(client: Valkey, defaultTtl?: number) {
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
  });
  await cache.initialize();
  return { cache, logger };
}

/** The usage-tracking EVAL commands recorded for a given entry key. */
function usageCommandsFor(state: MockState, key: string): QueuedCommand[] {
  return state.executed.filter((q) => isUsageCommand(q) && q.args[3] === key);
}

const KEYS = ['t:entry:k1', 't:entry:k2', 't:entry:k3'];
const PROMPTS = ['first', 'second', 'third'];

describe('entry usage tracking on cluster', () => {
  it('updates every matched key with one single-key EVAL pipeline each', async () => {
    const { client, state } = makeClient({ cluster: true });
    const { cache, logger } = await makeCache(client, TTL);

    const results = await cache.checkBatch(PROMPTS);

    expect(results.map((r) => r.matchedKey)).toEqual(KEYS);
    for (const key of KEYS) {
      const cmds = usageCommandsFor(state, key);
      expect(cmds).toHaveLength(1);
      // call('EVAL', <script>, '1', key, <now>, '300')
      expect(cmds[0].args).toEqual([
        'EVAL',
        expect.any(String),
        '1',
        key,
        expect.stringMatching(/^\d+$/),
        String(TTL),
      ]);
    }
    expect(state.usagePipelines).toEqual(KEYS.map((key) => [key]));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('passes an empty TTL arg to the script when defaultTtl is not set', async () => {
    const { client, state } = makeClient({ cluster: true });
    const { cache, logger } = await makeCache(client);

    await cache.checkBatch(PROMPTS);

    for (const key of KEYS) {
      const cmds = usageCommandsFor(state, key);
      expect(cmds).toHaveLength(1);
      // Empty ttl arg → the script leaves the existing expiry untouched.
      expect(cmds[0].args).toEqual([
        'EVAL',
        expect.any(String),
        '1',
        key,
        expect.stringMatching(/^\d+$/),
        '',
      ]);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('entry usage tracking on standalone', () => {
  it('sends exactly one pipeline for the whole batch', async () => {
    const { client, state } = makeClient({ cluster: false });
    const { cache, logger } = await makeCache(client, TTL);

    await cache.checkBatch(PROMPTS);

    expect(state.usagePipelines).toEqual([KEYS]);
    for (const key of KEYS) {
      const cmds = usageCommandsFor(state, key);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].args[0]).toBe('EVAL');
      expect(cmds[0].args[5]).toBe(String(TTL));
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('entry usage tracking failures', () => {
  it('still updates the other keys and warns once when one key fails', async () => {
    const { client, state } = makeClient({ cluster: true, failKey: 't:entry:k2' });
    const { cache, logger } = await makeCache(client, TTL);

    const results = await cache.checkBatch(PROMPTS);

    expect(results.every((r) => r.hit)).toBe(true);
    expect(usageCommandsFor(state, 't:entry:k1')).toHaveLength(1);
    expect(usageCommandsFor(state, 't:entry:k2')).toHaveLength(0);
    expect(usageCommandsFor(state, 't:entry:k3')).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(
      "@betterdb/semantic-cache 't': failed to record entry usage for 1/3 key(s)",
    );
    expect(logger.warn.mock.calls[0][0]).toContain('connection lost');
  });

  it('counts a WRONGTYPE error reported in exec() results as a failure', async () => {
    const { client } = makeClient({ cluster: false });
    const pipelineFn = client.pipeline as unknown as ReturnType<typeof vi.fn>;
    const realPipeline = pipelineFn.getMockImplementation()!;
    pipelineFn.mockImplementation(() => {
      const stub = realPipeline() as Record<string, unknown> & {
        call: ReturnType<typeof vi.fn>;
        exec: () => Promise<Array<[Error | null, unknown]>>;
      };
      const realExec = stub.exec;
      stub.exec = async () => {
        const results = await realExec();
        // Usage pipelines only: WRONGTYPE on the first key's EVAL.
        const isUsage = stub.call.mock.calls.some((c) => c[0] === 'EVAL');
        if (isUsage) results[0] = [new Error('WRONGTYPE Operation against a key'), null];
        return results;
      };
      return stub;
    });
    const { cache, logger } = await makeCache(client, TTL);

    await cache.checkBatch(PROMPTS);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('for 1/3 key(s)');
    expect(logger.warn.mock.calls[0][0]).toContain('WRONGTYPE');
  });

  it('does not count a 0 return (entry already gone) as a failure', async () => {
    const { client } = makeClient({ cluster: false });
    const pipelineFn = client.pipeline as unknown as ReturnType<typeof vi.fn>;
    const realPipeline = pipelineFn.getMockImplementation()!;
    pipelineFn.mockImplementation(() => {
      const stub = realPipeline() as Record<string, unknown> & {
        call: ReturnType<typeof vi.fn>;
        exec: () => Promise<Array<[Error | null, unknown]>>;
      };
      const realExec = stub.exec;
      stub.exec = async () => {
        const results = await realExec();
        // The script returns 0 when the key vanished after FT.SEARCH — a no-op,
        // never an error. It must not be tallied as a failed key.
        const isUsage = stub.call.mock.calls.some((c) => c[0] === 'EVAL');
        if (isUsage) {
          for (let i = 0; i < results.length; i++) results[i] = [null, 0];
        }
        return results;
      };
      return stub;
    });
    const { cache, logger } = await makeCache(client, TTL);

    const results = await cache.checkBatch(PROMPTS);

    expect(results.every((r) => r.hit)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('check() still resolves with the hit when usage tracking fails', async () => {
    const { client } = makeClient({ cluster: true, failKey: 't:entry:k1' });
    const { cache, logger } = await makeCache(client, TTL);

    const result = await cache.check('first');

    expect(result.hit).toBe(true);
    expect(result.matchedKey).toBe('t:entry:k1');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('for 1/1 key(s)');
  });
});
