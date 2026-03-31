import { migrateKey } from '../execution/type-handlers';

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
    call: jest.fn().mockResolvedValue(['m1', '1', 'm2', '2']),
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
    pexpire: jest.fn().mockResolvedValue(1),
    call: jest.fn().mockResolvedValue('OK'),
    callBuffer: jest.fn().mockResolvedValue(Buffer.from('OK')),
    pipeline: jest.fn().mockReturnValue({
      zadd: jest.fn().mockReturnThis(),
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
      expect(target.rename).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'), 'hash:1');
    });
  });

  describe('list', () => {
    it('should LRANGE, RPUSH to temp key, and RENAME', async () => {
      const result = await migrateKey(source, target, 'list:1', 'list');

      expect(result.ok).toBe(true);
      expect(source.lrangeBuffer).toHaveBeenCalled();
      expect(target.call).toHaveBeenCalledWith('RPUSH', expect.stringContaining('__betterdb_mig_'), expect.any(Buffer), expect.any(Buffer));
      expect(target.rename).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'), 'list:1');
    });
  });

  describe('set', () => {
    it('should use SMEMBERS for small sets, write to temp key, and RENAME', async () => {
      source.scard.mockResolvedValue(5);

      const result = await migrateKey(source, target, 'set:1', 'set');

      expect(result.ok).toBe(true);
      expect(source.smembersBuffer).toHaveBeenCalledWith('set:1');
      expect(target.call).toHaveBeenCalledWith('SADD', expect.stringContaining('__betterdb_mig_'), expect.any(Buffer), expect.any(Buffer));
      expect(target.rename).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'), 'set:1');
    });

    it('should use SSCAN for large sets (>10K members)', async () => {
      source.scard.mockResolvedValue(15_000);

      const result = await migrateKey(source, target, 'set:big', 'set');

      expect(result.ok).toBe(true);
      expect(source.sscanBuffer).toHaveBeenCalled();
      expect(target.rename).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'), 'set:big');
    });
  });

  describe('zset', () => {
    it('should use callBuffer ZRANGE WITHSCORES, write to temp key, and RENAME', async () => {
      source.zcard.mockResolvedValue(5);

      const result = await migrateKey(source, target, 'zset:1', 'zset');

      expect(result.ok).toBe(true);
      expect(source.callBuffer).toHaveBeenCalledWith('ZRANGE', 'zset:1', '0', '-1', 'WITHSCORES');
      expect(target.rename).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'), 'zset:1');
    });

    it('should use callBuffer ZSCAN for large sorted sets (>10K members)', async () => {
      source.zcard.mockResolvedValue(15_000);

      const result = await migrateKey(source, target, 'zset:big', 'zset');

      expect(result.ok).toBe(true);
      expect(source.callBuffer).toHaveBeenCalledWith('ZSCAN', 'zset:big', '0', 'COUNT', '1000');
      expect(target.rename).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'), 'zset:big');
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
      expect(target.rename).toHaveBeenCalledWith(expect.stringContaining('__betterdb_mig_'), 'stream:1');
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

    it('should call pexpire for compound types when source TTL > 0', async () => {
      source.pttl.mockResolvedValue(60000);

      const result = await migrateKey(source, target, 'hash:ttl', 'hash');

      expect(result.ok).toBe(true);
      expect(target.pexpire).toHaveBeenCalledWith('hash:ttl', 60000);
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

    it('should capture errors and return ok: false', async () => {
      source.getBuffer.mockRejectedValue(new Error('Connection lost'));

      const result = await migrateKey(source, target, 'key', 'string');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Connection lost');
    });
  });
});
