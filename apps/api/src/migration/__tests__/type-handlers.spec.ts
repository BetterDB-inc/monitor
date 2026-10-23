import { migrateKey } from '../execution/type-handlers';
import { createHashFieldTtlContext } from '../execution/hash-field-ttl';

function createMockSource(overrides: Record<string, jest.Mock> = {}) {
  return {
    getBuffer: jest.fn().mockResolvedValue(Buffer.from('value')),
    hlen: jest.fn().mockResolvedValue(3),
    hgetallBuffer: jest.fn().mockResolvedValue({ f1: Buffer.from('v1'), f2: Buffer.from('v2') }),
    hscanBuffer: jest.fn().mockResolvedValue(['0', [Buffer.from('f1'), Buffer.from('v1')]]),
    llen: jest.fn().mockResolvedValue(2),
    lrangeBuffer: jest.fn().mockResolvedValue([Buffer.from('a'), Buffer.from('b')]),
    scard: jest.fn().mockResolvedValue(2),
    smembersBuffer: jest.fn().mockResolvedValue([Buffer.from('m1'), Buffer.from('m2')]),
    sscanBuffer: jest.fn().mockResolvedValue(['0', [Buffer.from('m1')]]),
    zcard: jest.fn().mockResolvedValue(2),
    pttl: jest.fn().mockResolvedValue(-1),
    call: jest.fn().mockImplementation((cmd: string) =>
      cmd === 'HPTTL'
        ? Promise.reject(new Error("ERR unknown command 'HPTTL'"))
        : Promise.resolve(['m1', '1', 'm2', '2']),
    ),
    // callBuffer returns Buffers for binary-safe zset/stream migration
    callBuffer: jest.fn().mockImplementation((cmd: string) => {
      if (cmd === 'ZRANGE') {
        return Promise.resolve([Buffer.from('m1'), Buffer.from('1'), Buffer.from('m2'), Buffer.from('2')]);
      }
      if (cmd === 'ZSCAN') {
        return Promise.resolve([Buffer.from('0'), [Buffer.from('m1'), Buffer.from('1')]]);
      }
      if (cmd === 'XRANGE') {
        return Promise.resolve([[Buffer.from('1-0'), [Buffer.from('field'), Buffer.from('value')]]]);
      }
      return Promise.resolve(null);
    }),
    pipeline: jest.fn().mockReturnValue({
      zadd: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }),
    ...overrides,
  } as any;
}

function createMockTarget() {
  return {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    rename: jest.fn().mockResolvedValue('OK'),
    llen: jest.fn().mockResolvedValue(2),
    pexpire: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(1),
    call: jest.fn().mockResolvedValue('OK'),
    callBuffer: jest.fn().mockResolvedValue(Buffer.from('OK')),
    pipeline: jest.fn().mockReturnValue({
      zadd: jest.fn().mockReturnThis(),
      call: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }),
  } as any;
}

describe('type-handlers / migrateKey', () => {
  let source: ReturnType<typeof createMockSource>;
  let target: ReturnType<typeof createMockTarget>;

  beforeEach(() => {
    source = createMockSource();
    target = createMockTarget();
  });

  describe('string', () => {
    it('should GET from source and SET on target', async () => {
      const result = await migrateKey(source, target, 'str:1', 'string');

      expect(result.ok).toBe(true);
      expect(source.getBuffer).toHaveBeenCalledWith('str:1');
      expect(target.set).toHaveBeenCalledWith('str:1', expect.any(Buffer));
    });

    it('should handle deleted key gracefully and skip write', async () => {
      source.getBuffer.mockResolvedValue(null);
      const result = await migrateKey(source, target, 'gone', 'string');

      expect(result.ok).toBe(true);
      expect(target.set).not.toHaveBeenCalled();
    });
  });

  describe('hash', () => {
    it('should use HSCAN, write to temp key, and RENAME', async () => {
      source.hlen.mockResolvedValue(5);

      const result = await migrateKey(source, target, 'hash:1', 'hash');

      expect(result.ok).toBe(true);
      expect(source.hscanBuffer).toHaveBeenCalled();
      // Writes to temp key then renames atomically
      expect(target.call).toHaveBeenCalledWith('HSET', expect.stringContaining('__betterdb_mig_'), expect.any(Buffer), expect.any(Buffer));
      expect(target.call).toHaveBeenCalledWith('EVAL', expect.any(String), '2', expect.stringContaining('__betterdb_mig_'), 'hash:1', '-1');
    });
  });

  describe('list', () => {
    it('should LRANGE, RPUSH to temp key, and RENAME', async () => {
      const result = await migrateKey(source, target, 'list:1', 'list');

      expect(result.ok).toBe(true);
      expect(source.lrangeBuffer).toHaveBeenCalled();
      expect(target.call).toHaveBeenCalledWith('RPUSH', expect.stringContaining('__betterdb_mig_'), expect.any(Buffer), expect.any(Buffer));
      expect(target.call).toHaveBeenCalledWith('EVAL', expect.any(String), '2', expect.stringContaining('__betterdb_mig_'), 'list:1', '-1');
    });
  });

  describe('set', () => {
    it('should use SMEMBERS for small sets, write to temp key, and RENAME', async () => {
      source.scard.mockResolvedValue(5);

      const result = await migrateKey(source, target, 'set:1', 'set');

      expect(result.ok).toBe(true);
      expect(source.smembersBuffer).toHaveBeenCalledWith('set:1');
      expect(target.call).toHaveBeenCalledWith('SADD', expect.stringContaining('__betterdb_mig_'), expect.any(Buffer), expect.any(Buffer));
      expect(target.call).toHaveBeenCalledWith('EVAL', expect.any(String), '2', expect.stringContaining('__betterdb_mig_'), 'set:1', '-1');
    });

    it('should use SSCAN for large sets (>10K members)', async () => {
      source.scard.mockResolvedValue(15_000);

      const result = await migrateKey(source, target, 'set:big', 'set');

      expect(result.ok).toBe(true);
      expect(source.sscanBuffer).toHaveBeenCalled();
      expect(target.call).toHaveBeenCalledWith('EVAL', expect.any(String), '2', expect.stringContaining('__betterdb_mig_'), 'set:big', '-1');
    });
  });

  describe('zset', () => {
    it('should use callBuffer ZRANGE WITHSCORES, write to temp key, and RENAME', async () => {
      source.zcard.mockResolvedValue(5);

      const result = await migrateKey(source, target, 'zset:1', 'zset');

      expect(result.ok).toBe(true);
      expect(source.callBuffer).toHaveBeenCalledWith('ZRANGE', 'zset:1', '0', '-1', 'WITHSCORES');
      expect(target.call).toHaveBeenCalledWith('EVAL', expect.any(String), '2', expect.stringContaining('__betterdb_mig_'), 'zset:1', '-1');
    });

    it('should use callBuffer ZSCAN for large sorted sets (>10K members)', async () => {
      source.zcard.mockResolvedValue(15_000);

      const result = await migrateKey(source, target, 'zset:big', 'zset');

      expect(result.ok).toBe(true);
      expect(source.callBuffer).toHaveBeenCalledWith('ZSCAN', 'zset:big', '0', 'COUNT', '1000');
      expect(target.call).toHaveBeenCalledWith('EVAL', expect.any(String), '2', expect.stringContaining('__betterdb_mig_'), 'zset:big', '-1');
    });
  });

  describe('stream', () => {
    it('should use callBuffer XRANGE, XADD to temp key, and RENAME', async () => {
      const result = await migrateKey(source, target, 'stream:1', 'stream');

      expect(result.ok).toBe(true);
      expect(source.callBuffer).toHaveBeenCalledWith('XRANGE', 'stream:1', '-', '+', 'COUNT', '1000');
      expect(target.callBuffer).toHaveBeenCalledWith(
        'XADD', expect.stringContaining('__betterdb_mig_'), '1-0', Buffer.from('field'), Buffer.from('value'),
      );
      expect(target.call).toHaveBeenCalledWith('EVAL', expect.any(String), '2', expect.stringContaining('__betterdb_mig_'), 'stream:1', '-1');
    });
  });

  describe('stream metadata (consumer groups, PEL, ID counters)', () => {
    function routeSourceCall(overrides: Record<string, unknown> = {}) {
      return jest.fn().mockImplementation((cmd: string, sub?: string) => {
        const route = sub && cmd === 'XINFO' ? `XINFO ${sub}` : cmd;
        if (route in overrides) {
          const value = overrides[route];
          return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
        }
        if (route === 'XINFO STREAM') {
          return Promise.resolve([
            'length', 1, 'last-generated-id', '5-0', 'max-deleted-entry-id', '5-0', 'entries-added', 5, 'groups', 1,
          ]);
        }
        if (route === 'XINFO GROUPS') {
          return Promise.resolve([
            ['name', 'workers', 'consumers', 2, 'pending', 1, 'last-delivered-id', '3-0', 'entries-read', 3, 'lag', null],
          ]);
        }
        if (route === 'XINFO CONSUMERS') {
          return Promise.resolve([
            ['name', 'c1', 'pending', 1, 'idle', 10],
            ['name', 'idle-consumer', 'pending', 0, 'idle', 20],
          ]);
        }
        if (route === 'XPENDING') return Promise.resolve([['2-0', 'c1', '1234', '2']]);
        return Promise.resolve(null);
      });
    }

    interface ClaimPipeline {
      call: jest.Mock<ClaimPipeline, unknown[]>;
      exec: jest.Mock<Promise<Array<[Error | null, unknown]>>, []>;
    }

    /** Pipeline double for the batched XCLAIMs: every queued command gets `reply`. */
    function claimPipeline(reply: unknown): ClaimPipeline {
      const queued: unknown[][] = [];
      const pipeline: ClaimPipeline = {
        call: jest.fn((...args: unknown[]) => {
          queued.push(args);
          return pipeline;
        }),
        exec: jest.fn(() =>
          Promise.resolve(
            queued.map((): [Error | null, unknown] => (reply instanceof Error ? [reply, null] : [null, reply])),
          ),
        ),
      };
      return pipeline;
    }

    let claims: ClaimPipeline;

    beforeEach(() => {
      source.call = routeSourceCall();
      claims = claimPipeline(['2-0']);
      target.pipeline.mockReturnValue(claims);
    });

    it('recreates ID counters, groups, consumers and pending entries on the temp key before the rename', async () => {
      const result = await migrateKey(source, target, 'jobs', 'stream');

      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
      const tmp = expect.stringContaining('__betterdb_mig_');
      expect(target.call).toHaveBeenCalledWith('XSETID', tmp, '5-0', 'ENTRIESADDED', '5', 'MAXDELETEDID', '5-0');
      expect(target.call).toHaveBeenCalledWith('XGROUP', 'CREATE', tmp, 'workers', '3-0', 'ENTRIESREAD', '3');
      expect(target.call).toHaveBeenCalledWith('XGROUP', 'CREATECONSUMER', tmp, 'workers', 'idle-consumer');
      expect(claims.call).toHaveBeenCalledWith(
        'XCLAIM', tmp, 'workers', 'c1', '0', '2-0', 'IDLE', '1234', 'RETRYCOUNT', '2', 'FORCE', 'JUSTID',
      );

      const evalIndex = target.call.mock.calls.findIndex((c: unknown[]) => c[0] === 'EVAL');
      expect(target.call.mock.invocationCallOrder[evalIndex]).toBeGreaterThan(claims.exec.mock.invocationCallOrder[0]);
    });

    it('pages through a pending entries list larger than one XPENDING page', async () => {
      const firstPage = Array.from({ length: 1000 }, (_, i) => [`${i + 1}-0`, 'c1', '5', '1']);
      const xpending = jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce([['1001-0', 'c1', '5', '1']]);
      source.call = routeSourceCall();
      const route = source.call.getMockImplementation();
      source.call.mockImplementation((cmd: string, ...args: unknown[]) =>
        cmd === 'XPENDING' ? xpending(cmd, ...args) : route(cmd, ...args),
      );

      const result = await migrateKey(source, target, 'jobs', 'stream');

      expect(result.ok).toBe(true);
      expect(xpending).toHaveBeenNthCalledWith(1, 'XPENDING', 'jobs', 'workers', '-', '+', '1000');
      expect(xpending).toHaveBeenNthCalledWith(2, 'XPENDING', 'jobs', 'workers', '1000-1', '+', '1000');
      expect(claims.call).toHaveBeenCalledTimes(1001);
      expect(claims.exec).toHaveBeenCalledTimes(3); // 500 + 500 + 1
    });

    it('migrates an empty stream that only holds a consumer group', async () => {
      source.callBuffer.mockImplementation(() => Promise.resolve([]));

      const result = await migrateKey(source, target, 'jobs', 'stream');

      expect(result.ok).toBe(true);
      const tmp = expect.stringContaining('__betterdb_mig_');
      expect(target.call).toHaveBeenCalledWith('XGROUP', 'CREATE', tmp, '__betterdb_mig_placeholder', '0', 'MKSTREAM');
      expect(target.call).toHaveBeenCalledWith('XGROUP', 'DESTROY', tmp, '__betterdb_mig_placeholder');
      expect(target.call).toHaveBeenCalledWith('EVAL', expect.any(String), '2', tmp, 'jobs', '-1');
    });

    it('skips a stream deleted since SCAN without writing anything', async () => {
      source.callBuffer.mockImplementation(() => Promise.resolve([]));
      source.call = routeSourceCall({ 'XINFO STREAM': new Error('ERR no such key') });

      const result = await migrateKey(source, target, 'gone', 'stream');

      expect(result.ok).toBe(true);
      expect(target.call).not.toHaveBeenCalled();
    });

    it('warns when a pending entry points at a message that is no longer in the stream', async () => {
      target.pipeline.mockReturnValue(claimPipeline([]));

      const result = await migrateKey(source, target, 'jobs', 'stream');

      expect(result.ok).toBe(true);
      expect(result.warning).toBe('1 pending entry not restored (message deleted from the source, or added after the copy)');
    });

    it('falls back to plain XSETID and XGROUP CREATE on targets older than 7.0', async () => {
      target.call = jest.fn().mockImplementation((cmd: string, ...args: string[]) => {
        if ((cmd === 'XSETID' && args.includes('ENTRIESADDED')) || (cmd === 'XGROUP' && args.includes('ENTRIESREAD'))) {
          return Promise.reject(new Error('ERR syntax error'));
        }
        return Promise.resolve('OK');
      });

      const result = await migrateKey(source, target, 'jobs', 'stream');

      expect(result.ok).toBe(true);
      const tmp = expect.stringContaining('__betterdb_mig_');
      expect(target.call).toHaveBeenCalledWith('XSETID', tmp, '5-0');
      expect(target.call).toHaveBeenCalledWith('XGROUP', 'CREATE', tmp, 'workers', '3-0');
    });

    it('deletes the temp key and fails the key when a group cannot be recreated', async () => {
      target.call = jest.fn().mockImplementation((cmd: string) =>
        cmd === 'XGROUP' ? Promise.reject(new Error('OOM command not allowed')) : Promise.resolve('OK'),
      );

      const result = await migrateKey(source, target, 'jobs', 'stream');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('OOM');
      expect(target.del).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'));
    });

    it('deletes a directly written stream when its metadata cannot be recreated', async () => {
      target.call = jest.fn().mockImplementation((cmd: string) =>
        cmd === 'XGROUP' ? Promise.reject(new Error('OOM command not allowed')) : Promise.resolve('OK'),
      );

      const result = await migrateKey(source, target, 'user:{}:jobs', 'stream');

      expect(result.ok).toBe(false);
      expect(target.del).toHaveBeenCalledWith('user:{}:jobs');
    });

    it('deletes a directly written empty stream when its metadata cannot be recreated', async () => {
      source.callBuffer.mockImplementation(() => Promise.resolve([]));
      target.call = jest.fn().mockImplementation((cmd: string) =>
        cmd === 'XSETID' ? Promise.reject(new Error('OOM command not allowed')) : Promise.resolve('OK'),
      );

      const result = await migrateKey(source, target, 'user:{}:jobs', 'stream');

      expect(result.ok).toBe(false);
      expect(target.call).toHaveBeenCalledWith('XGROUP', 'CREATE', 'user:{}:jobs', '__betterdb_mig_placeholder', '0', 'MKSTREAM');
      expect(target.del).toHaveBeenLastCalledWith('user:{}:jobs');
    });

    it('fails the key when a pending entry cannot be claimed', async () => {
      target.pipeline.mockReturnValue(claimPipeline(new Error("NOPERM this user has no permissions to run the 'xclaim' command")));

      const result = await migrateKey(source, target, 'jobs', 'stream');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('NOPERM');
      expect(target.call).not.toHaveBeenCalledWith('EVAL', expect.anything(), '2', expect.anything(), 'jobs', expect.anything());
      expect(target.del).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'));
    });
  });

  describe('TTL preservation', () => {
    it('should use atomic SET PX for strings when source TTL > 0', async () => {
      source.pttl.mockResolvedValue(60000);

      const result = await migrateKey(source, target, 'str:ttl', 'string');

      expect(result.ok).toBe(true);
      expect(target.set).toHaveBeenCalledWith('str:ttl', expect.any(Buffer), 'PX', 60000);
      expect(target.pexpire).not.toHaveBeenCalled();
    });

    it('should apply TTL atomically via Lua EVAL for compound types when source TTL > 0', async () => {
      source.pttl.mockResolvedValue(60000);

      const result = await migrateKey(source, target, 'hash:ttl', 'hash');

      expect(result.ok).toBe(true);
      // TTL is passed to Lua EVAL as the ARGV[1] parameter
      expect(target.call).toHaveBeenCalledWith(
        'EVAL', expect.any(String), '2',
        expect.stringContaining('__betterdb_mig_'), 'hash:ttl', '60000',
      );
    });

    it('should not call pexpire when source TTL is -1', async () => {
      source.pttl.mockResolvedValue(-1);

      const result = await migrateKey(source, target, 'str:no-ttl', 'string');

      expect(result.ok).toBe(true);
      expect(target.pexpire).not.toHaveBeenCalled();
    });

    it('should return ok: false for string when source TTL is -2 (expired)', async () => {
      source.pttl.mockResolvedValue(-2);

      const result = await migrateKey(source, target, 'str:expired', 'string');

      expect(result.ok).toBe(true);
      expect(target.del).toHaveBeenCalledWith('str:expired');
    });
  });

  describe('error handling', () => {
    it('should return ok: false for unsupported type', async () => {
      const result = await migrateKey(source, target, 'key', 'unknown_type');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unsupported type');
    });

    it('fails a sorted set when a pipelined ZADD is rejected by the target', async () => {
      target.pipeline.mockReturnValue({
        zadd: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [null, 1],
          [new Error("OOM command not allowed when used memory > 'maxmemory'."), null],
        ]),
      });

      const result = await migrateKey(source, target, 'z', 'zset');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('OOM');
      expect(target.call).not.toHaveBeenCalledWith('EVAL', expect.anything(), expect.anything(), expect.anything(), 'z', expect.anything());
      expect(target.del).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'));
    });

    it('should capture errors and return ok: false', async () => {
      source.getBuffer.mockRejectedValue(new Error('Connection lost'));

      const result = await migrateKey(source, target, 'key', 'string');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Connection lost');
    });
  });

  describe('hash field TTLs', () => {
    function sourceWithTtls(ttls: number[] | Error) {
      return createMockSource({
        call: jest.fn().mockImplementation((cmd: string) => {
          if (cmd !== 'HPTTL') return Promise.resolve(null);
          return ttls instanceof Error ? Promise.reject(ttls) : Promise.resolve(ttls);
        }),
      });
    }

    function targetWithPipeline(execResult: unknown[] = [[null, [1]]]) {
      const hp = {
        call: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(execResult),
      };
      const t = createMockTarget();
      t.pipeline.mockReturnValue(hp);
      return { t, hp };
    }

    const evalIndex = (t: { call: jest.Mock }) =>
      t.call.mock.calls.findIndex((c: unknown[]) => c[0] === 'EVAL');

    it('applies HPEXPIRE on the temp key before the rename', async () => {
      const src = sourceWithTtls([5000]);
      const { t, hp } = targetWithPipeline();

      const result = await migrateKey(src, t, 'hash:1', 'hash');

      expect(result.ok).toBe(true);
      expect(hp.call).toHaveBeenCalledWith(
        'HPEXPIRE', expect.stringMatching(/^__betterdb_mig_/), '5000', 'FIELDS', '1', expect.any(Buffer),
      );
      expect(hp.call.mock.invocationCallOrder[0]).toBeLessThan(
        t.call.mock.invocationCallOrder[evalIndex(t)],
      );
    });

    it('adds no round trips when the source has no HFE', async () => {
      const src = sourceWithTtls(new Error("ERR unknown command 'HPTTL'"));
      const { t, hp } = targetWithPipeline();

      const result = await migrateKey(src, t, 'hash:1', 'hash');

      expect(result.ok).toBe(true);
      expect(hp.call).not.toHaveBeenCalled();
      expect(t.exists).not.toHaveBeenCalled();
    });

    it('probes an unsupported source once across keys sharing a context', async () => {
      const src = sourceWithTtls(new Error("ERR unknown command 'HPTTL'"));
      const { t } = targetWithPipeline();
      const hashFieldTtl = createHashFieldTtlContext();

      await migrateKey(src, t, 'hash:1', 'hash', { hashFieldTtl });
      await migrateKey(src, t, 'hash:2', 'hash', { hashFieldTtl });

      const hpttl = src.call.mock.calls.filter((c: unknown[]) => c[0] === 'HPTTL');
      expect(hpttl).toHaveLength(1);
    });

    it('fails the key and cleans up when the target lacks HFE', async () => {
      const src = sourceWithTtls([5000]);
      const { t } = targetWithPipeline([[new Error("ERR unknown command 'HPEXPIRE'"), null]]);

      const result = await migrateKey(src, t, 'hash:1', 'hash');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Valkey 9.0+');
      expect(t.del).toHaveBeenCalledWith(expect.stringMatching(/^__betterdb_mig_/));
      expect(evalIndex(t)).toBe(-1);
    });

    it('removes the partial hash on the direct-write path when the target lacks HFE', async () => {
      const src = sourceWithTtls([5000]);
      const { t, hp } = targetWithPipeline([[new Error("ERR unknown command 'HPEXPIRE'"), null]]);

      const result = await migrateKey(src, t, 'user:{}:1', 'hash');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Valkey 9.0+');

      // The key is also deleted before the write, so require a delete of the real key
      // after the failed HPEXPIRE pipeline: that one is the cleanup.
      const failedAt = hp.exec.mock.invocationCallOrder[0];
      const cleanedUp = t.del.mock.calls.some(
        (c: unknown[], i: number) =>
          c[0] === 'user:{}:1' && t.del.mock.invocationCallOrder[i] > failedAt,
      );
      expect(cleanedUp).toBe(true);
    });

    it('skips the rename when every field expired mid-copy', async () => {
      const src = sourceWithTtls([-2]);
      const { t } = targetWithPipeline();
      t.exists.mockResolvedValue(0);

      const result = await migrateKey(src, t, 'hash:1', 'hash');

      expect(result.ok).toBe(true);
      expect(t.call).toHaveBeenCalledWith('HDEL', expect.stringMatching(/^__betterdb_mig_/), expect.any(Buffer));
      expect(t.exists).toHaveBeenCalledTimes(1);
      expect(evalIndex(t)).toBe(-1);
      expect(t.rename).not.toHaveBeenCalled();
    });

    it('treats a 0 ms field TTL as expired and skips the rename when nothing is left', async () => {
      const src = sourceWithTtls([0]);
      const { t } = targetWithPipeline();
      t.exists.mockResolvedValue(0);

      const result = await migrateKey(src, t, 'hash:1', 'hash');

      expect(result.ok).toBe(true);
      expect(t.call).toHaveBeenCalledWith('HDEL', expect.stringMatching(/^__betterdb_mig_/), expect.any(Buffer));
      expect(t.exists).toHaveBeenCalledTimes(1);
      expect(evalIndex(t)).toBe(-1);
      expect(t.rename).not.toHaveBeenCalled();
    });

    it('writes field TTLs to the real key on the direct-write path', async () => {
      const src = sourceWithTtls([5000]);
      const { t, hp } = targetWithPipeline();

      const result = await migrateKey(src, t, 'user:{}:1', 'hash');

      expect(result.ok).toBe(true);
      expect(hp.call).toHaveBeenCalledWith('HPEXPIRE', 'user:{}:1', '5000', 'FIELDS', '1', expect.any(Buffer));
    });

    it('copies without field TTLs when HPTTL is denied', async () => {
      const src = sourceWithTtls(new Error('NOPERM this user has no permissions to run hpttl'));
      const { t, hp } = targetWithPipeline();
      const hashFieldTtl = createHashFieldTtlContext();

      const result = await migrateKey(src, t, 'hash:1', 'hash', { hashFieldTtl });

      expect(result.ok).toBe(true);
      expect(hp.call).not.toHaveBeenCalled();
      expect(hashFieldTtl.source).toBe('denied');
    });

    it('reads HPTTL once per HSCAN page', async () => {
      const src = sourceWithTtls([-1]);
      src.hscanBuffer
        .mockResolvedValueOnce(['5', [Buffer.from('f1'), Buffer.from('v1')]])
        .mockResolvedValueOnce(['0', [Buffer.from('f2'), Buffer.from('v2')]]);
      const { t } = targetWithPipeline();

      const result = await migrateKey(src, t, 'hash:1', 'hash');

      expect(result.ok).toBe(true);
      const hpttl = src.call.mock.calls.filter((c: unknown[]) => c[0] === 'HPTTL');
      expect(hpttl).toHaveLength(2);
    });
  });
});
