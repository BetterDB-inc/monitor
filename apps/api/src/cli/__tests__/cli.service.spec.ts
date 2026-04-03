import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CliService } from '../cli.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';

// Mock iovalkey
const mockCall = jest.fn();
const mockQuit = jest.fn().mockResolvedValue(undefined);
const mockConnect = jest.fn().mockResolvedValue(undefined);

jest.mock('iovalkey', () => {
  return jest.fn().mockImplementation(() => ({
    call: mockCall,
    quit: mockQuit,
    connect: mockConnect,
    status: 'ready',
  }));
});

describe('CliService', () => {
  let service: CliService;

  const mockConfig = {
    id: 'test-conn',
    name: 'Test',
    host: 'localhost',
    port: 6379,
    username: 'default',
    password: '',
    dbIndex: 0,
  };

  const mockConnectionRegistry = {
    getConfig: jest.fn().mockReturnValue(mockConfig),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CliService,
        {
          provide: ConnectionRegistry,
          useValue: mockConnectionRegistry,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(false),
          },
        },
      ],
    }).compile();

    service = module.get<CliService>(CliService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('blocked commands', () => {
    it('should reject SUBSCRIBE', async () => {
      const result = await service.execute('SUBSCRIBE channel');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('blocked');
    });

    it('should reject MONITOR', async () => {
      const result = await service.execute('MONITOR');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('blocked');
    });

    it('should reject BLPOP', async () => {
      const result = await service.execute('BLPOP list 0');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('blocked');
    });

    it('should reject CLIENT PAUSE', async () => {
      const result = await service.execute('CLIENT PAUSE 1000');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('blocked');
    });
  });

  describe('safe mode restrictions', () => {
    it('should reject SET in safe mode', async () => {
      const result = await service.execute('SET foo bar');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('not allowed in safe mode');
    });

    it('should reject DEL in safe mode', async () => {
      const result = await service.execute('DEL foo');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('not allowed in safe mode');
    });

    it('should reject FLUSHDB in safe mode', async () => {
      const result = await service.execute('FLUSHDB');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('not allowed in safe mode');
    });

    it('should allow PING in safe mode', async () => {
      mockCall.mockResolvedValueOnce('PONG');
      const result = await service.execute('PING');
      expect(result.type).toBe('result');
    });

    it('should allow INFO in safe mode', async () => {
      mockCall.mockResolvedValueOnce('# Server\r\nredis_version:7.0.0');
      const result = await service.execute('INFO');
      expect(result.type).toBe('result');
    });

    it('should allow DBSIZE in safe mode', async () => {
      mockCall.mockResolvedValueOnce(42);
      const result = await service.execute('DBSIZE');
      expect(result.type).toBe('result');
    });

    it('should reject CONFIG SET in safe mode', async () => {
      const result = await service.execute('CONFIG SET maxmemory 100mb');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('not allowed in safe mode');
    });

    it('should allow CONFIG GET in safe mode', async () => {
      mockCall.mockResolvedValueOnce(['maxmemory', '0']);
      const result = await service.execute('CONFIG GET maxmemory');
      expect(result.type).toBe('result');
    });
  });

  describe('response formatting', () => {
    it('should format string responses', async () => {
      mockCall.mockResolvedValueOnce('PONG');
      const result = await service.execute('PING');
      expect(result).toMatchObject({
        type: 'result',
        result: '"PONG"',
        resultType: 'string',
      });
    });

    it('should format integer responses', async () => {
      mockCall.mockResolvedValueOnce(42);
      const result = await service.execute('DBSIZE');
      expect(result).toMatchObject({
        type: 'result',
        result: '(integer) 42',
        resultType: 'integer',
      });
    });

    it('should format nil responses', async () => {
      mockCall.mockResolvedValueOnce(null);
      const result = await service.execute('GET nonexistent');
      expect(result).toMatchObject({
        type: 'result',
        result: '(nil)',
        resultType: 'nil',
      });
    });

    it('should format array responses', async () => {
      mockCall.mockResolvedValueOnce(['key1', 'key2', 'key3']);
      const result = await service.execute('KEYS *');
      expect(result).toMatchObject({
        type: 'result',
        resultType: 'array',
      });
      expect((result as { result: string }).result).toContain('1) "key1"');
      expect((result as { result: string }).result).toContain('2) "key2"');
      expect((result as { result: string }).result).toContain('3) "key3"');
    });

    it('should format empty array responses', async () => {
      mockCall.mockResolvedValueOnce([]);
      const result = await service.execute('KEYS nonexistent*');
      expect(result).toMatchObject({
        type: 'result',
        result: '(empty array)',
        resultType: 'empty-array',
      });
    });

    it('should format nested array responses', async () => {
      mockCall.mockResolvedValueOnce([['a', 'b'], ['c', 'd']]);
      const result = await service.execute('XRANGE mystream - +');
      expect(result).toMatchObject({
        type: 'result',
        resultType: 'array',
      });
      const text = (result as { result: string }).result;
      expect(text).toContain('1)');
      expect(text).toContain('"a"');
      expect(text).toContain('"b"');
    });

    it('should format error responses from Valkey', async () => {
      mockCall.mockRejectedValueOnce(new Error('ERR wrong number of arguments'));
      const result = await service.execute('GET');
      expect(result).toMatchObject({
        type: 'result',
        resultType: 'error',
      });
      expect((result as { result: string }).result).toContain('ERR wrong number of arguments');
    });

    it('should include durationMs in responses', async () => {
      mockCall.mockResolvedValueOnce('PONG');
      const result = await service.execute('PING');
      expect(result.type).toBe('result');
      expect((result as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('empty command', () => {
    it('should return error for empty command', async () => {
      const result = await service.execute('');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toBe('Empty command');
    });

    it('should return error for whitespace-only command', async () => {
      const result = await service.execute('   ');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toBe('Empty command');
    });
  });

  describe('subcommand enforcement in safe mode', () => {
    it('should reject bare CONFIG without subcommand', async () => {
      const result = await service.execute('CONFIG');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('requires a sub-command');
    });

    it('should reject bare CLIENT without subcommand', async () => {
      const result = await service.execute('CLIENT');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('requires a sub-command');
    });

    it('should reject SENTINEL (removed from safe commands)', async () => {
      const result = await service.execute('SENTINEL MASTERS');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('not allowed in safe mode');
    });

    it('should reject SLOWLOG RESET in safe mode', async () => {
      const result = await service.execute('SLOWLOG RESET');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('not allowed in safe mode');
    });

    it('should allow SLOWLOG GET in safe mode', async () => {
      mockCall.mockResolvedValueOnce([]);
      const result = await service.execute('SLOWLOG GET');
      expect(result.type).toBe('result');
    });
  });

  describe('credential status check', () => {
    it('should return error for connections with decryption failure', async () => {
      mockConnectionRegistry.getConfig.mockReturnValueOnce({
        ...mockConfig,
        credentialStatus: 'decryption_failed',
      });
      const result = await service.execute('PING');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('decryption failed');
    });
  });
});

describe('CliService (unsafe mode)', () => {
  let unsafeService: CliService;

  const mockConfig = {
    id: 'test-conn',
    name: 'Test',
    host: 'localhost',
    port: 6379,
    username: 'default',
    password: '',
    dbIndex: 0,
  };

  const mockConnectionRegistry = {
    getConfig: jest.fn().mockReturnValue(mockConfig),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CliService,
        {
          provide: ConnectionRegistry,
          useValue: mockConnectionRegistry,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(true),
          },
        },
      ],
    }).compile();

    unsafeService = module.get<CliService>(CliService);
  });

  afterEach(async () => {
    await unsafeService.onModuleDestroy();
  });

  it('should allow SET in unsafe mode', async () => {
    mockCall.mockResolvedValueOnce('OK');
    const result = await unsafeService.execute('SET foo bar');
    expect(result.type).toBe('result');
    expect((result as { result: string }).result).toBe('"OK"');
  });

  it('should allow DEL in unsafe mode', async () => {
    mockCall.mockResolvedValueOnce(1);
    const result = await unsafeService.execute('DEL foo');
    expect(result.type).toBe('result');
    expect((result as { result: string }).result).toBe('(integer) 1');
  });

  it('should still block SUBSCRIBE in unsafe mode', async () => {
    const result = await unsafeService.execute('SUBSCRIBE channel');
    expect(result.type).toBe('error');
    expect((result as { error: string }).error).toContain('blocked');
  });

  it('should still block MONITOR in unsafe mode', async () => {
    const result = await unsafeService.execute('MONITOR');
    expect(result.type).toBe('error');
    expect((result as { error: string }).error).toContain('blocked');
  });

  it('should allow CONFIG SET in unsafe mode', async () => {
    mockCall.mockResolvedValueOnce('OK');
    const result = await unsafeService.execute('CONFIG SET hz 15');
    expect(result.type).toBe('result');
  });
});
