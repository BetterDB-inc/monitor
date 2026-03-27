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
    zscan: jest.fn().mockResolvedValue(['0', ['m1', '1', 'm2', '2']]),
    xrange: jest.fn().mockResolvedValue([['1-0', ['field', 'value']]]),
    pttl: jest.fn().mockResolvedValue(-1),
    call: jest.fn().mockResolvedValue(['m1', '1', 'm2', '2']),
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
    hset: jest.fn().mockResolvedValue(1),
    rpush: jest.fn().mockResolvedValue(1),
    sadd: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
    xadd: jest.fn().mockResolvedValue('1-0'),
    pexpire: jest.fn().mockResolvedValue(1),
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

    it('should handle deleted key gracefully', async () => {
      source.getBuffer.mockResolvedValue(null);
      const result = await migrateKey(source, target, 'gone', 'string');

      // migrateString returns early without setting, then migrateTtl runs — no error
      expect(result.ok).toBe(true);
      expect(target.set).not.toHaveBeenCalled();
    });
  });

  describe('hash', () => {
    it('should use HGETALL for small hashes', async () => {
      source.hlen.mockResolvedValue(5);

      const result = await migrateKey(source, target, 'hash:1', 'hash');

      expect(result.ok).toBe(true);
      expect(source.hgetallBuffer).toHaveBeenCalledWith('hash:1');
      expect(target.hset).toHaveBeenCalled();
    });

    it('should use HSCAN for large hashes (>10K fields)', async () => {
      source.hlen.mockResolvedValue(15_000);

      const result = await migrateKey(source, target, 'hash:big', 'hash');

      expect(result.ok).toBe(true);
      expect(source.hscanBuffer).toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should LRANGE and RPUSH to target', async () => {
      const result = await migrateKey(source, target, 'list:1', 'list');

      expect(result.ok).toBe(true);
      expect(source.lrangeBuffer).toHaveBeenCalled();
      expect(target.rpush).toHaveBeenCalled();
    });

    it('should delete target key first to avoid appending', async () => {
      const result = await migrateKey(source, target, 'list:1', 'list');

      expect(result.ok).toBe(true);
      expect(target.del).toHaveBeenCalledWith('list:1');
    });
  });

  describe('set', () => {
    it('should use SMEMBERS for small sets', async () => {
      source.scard.mockResolvedValue(5);

      const result = await migrateKey(source, target, 'set:1', 'set');

      expect(result.ok).toBe(true);
      expect(source.smembersBuffer).toHaveBeenCalledWith('set:1');
      expect(target.sadd).toHaveBeenCalled();
    });

    it('should use SSCAN for large sets (>10K members)', async () => {
      source.scard.mockResolvedValue(15_000);

      const result = await migrateKey(source, target, 'set:big', 'set');

      expect(result.ok).toBe(true);
      expect(source.sscanBuffer).toHaveBeenCalled();
    });
  });

  describe('zset', () => {
    it('should use ZRANGE WITHSCORES for small sorted sets', async () => {
      source.zcard.mockResolvedValue(5);

      const result = await migrateKey(source, target, 'zset:1', 'zset');

      expect(result.ok).toBe(true);
      expect(source.call).toHaveBeenCalledWith('ZRANGE', 'zset:1', '0', '-1', 'WITHSCORES');
    });

    it('should use ZSCAN for large sorted sets (>10K members)', async () => {
      source.zcard.mockResolvedValue(15_000);

      const result = await migrateKey(source, target, 'zset:big', 'zset');

      expect(result.ok).toBe(true);
      expect(source.zscan).toHaveBeenCalled();
    });
  });

  describe('stream', () => {
    it('should XRANGE and XADD with preserved IDs', async () => {
      const result = await migrateKey(source, target, 'stream:1', 'stream');

      expect(result.ok).toBe(true);
      expect(source.xrange).toHaveBeenCalled();
      expect(target.xadd).toHaveBeenCalledWith('stream:1', '1-0', 'field', 'value');
    });
  });

  describe('TTL preservation', () => {
    it('should call pexpire on target when source TTL > 0', async () => {
      source.pttl.mockResolvedValue(60000);

      const result = await migrateKey(source, target, 'str:ttl', 'string');

      expect(result.ok).toBe(true);
      expect(target.pexpire).toHaveBeenCalledWith('str:ttl', 60000);
    });

    it('should not call pexpire when source TTL is -1', async () => {
      source.pttl.mockResolvedValue(-1);

      const result = await migrateKey(source, target, 'str:no-ttl', 'string');

      expect(result.ok).toBe(true);
      expect(target.pexpire).not.toHaveBeenCalled();
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
