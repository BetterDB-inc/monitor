import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { CliService } from '../cli.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';

const mockCall = jest.fn();

function createMockAdapter() {
  return {
    isConnected: jest.fn().mockReturnValue(true),
    call: mockCall,
  };
}

describe('CliService', () => {
  let service: CliService;

  const mockConnectionRegistry = {
    get: jest.fn().mockImplementation(() => createMockAdapter()),
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

  describe('blocked commands', () => {
    it.each([['SUBSCRIBE channel'], ['MONITOR'], ['BLPOP list 0'], ['CLIENT PAUSE 1000']])(
      'should reject blocked command: %s',
      async (command) => {
        const result = await service.execute(command);
        expect(result.type).toBe('error');
        expect((result as { error: string }).error).toContain('blocked');
      },
    );
  });

  describe('safe mode restrictions', () => {
    it.each([['SET foo bar'], ['DEL foo'], ['FLUSHDB'], ['CONFIG SET maxmemory 100mb']])(
      'should reject %s in safe mode',
      async (command) => {
        const result = await service.execute(command);
        expect(result.type).toBe('error');
        expect((result as { error: string }).error).toContain('not allowed in safe mode');
      },
    );

    it.each([
      ['PING', 'PONG'],
      ['INFO', '# Server\r\nredis_version:7.0.0'],
      ['DBSIZE', 42],
      ['CONFIG GET maxmemory', ['maxmemory', '0']],
    ])('should allow %s in safe mode', async (command, mockResponse) => {
      mockCall.mockResolvedValueOnce(mockResponse);
      const result = await service.execute(command);
      expect(result.type).toBe('result');
    });
  });

  describe('response formatting', () => {
    it.each([
      ['string', 'PONG', 'PONG', 'string'],
      ['integer', 42, '(integer) 42', 'integer'],
      ['nil', null, '(nil)', 'nil'],
      ['empty array', [], '(empty array)', 'empty-array'],
    ])(
      'should format %s responses',
      async (_label, mockResponse, expectedResult, expectedType) => {
        mockCall.mockResolvedValueOnce(mockResponse);
        const result = await service.execute('PING');
        expect(result).toMatchObject({
          type: 'result',
          result: expectedResult,
          resultType: expectedType,
        });
      },
    );

    it('should format array responses with numbered entries', async () => {
      mockCall.mockResolvedValueOnce(['entry1', 'entry2', 'entry3']);
      const result = await service.execute('SLOWLOG GET');
      const text = (result as { result: string }).result;
      expect(result).toMatchObject({ type: 'result', resultType: 'array' });
      expect(text).toContain('1) entry1');
      expect(text).toContain('3) entry3');
    });

    it('should format nested array responses', async () => {
      mockCall.mockResolvedValueOnce([['a', 'b'], ['c', 'd']]);
      const result = await service.execute('LATENCY LATEST');
      const text = (result as { result: string }).result;
      expect(result).toMatchObject({ type: 'result', resultType: 'array' });
      expect(text).toContain('a');
      expect(text).toContain('d');
    });

    it('should format Valkey errors', async () => {
      mockCall.mockRejectedValueOnce(new Error('ERR wrong number of arguments'));
      const result = await service.execute('PING');
      expect(result).toMatchObject({ type: 'result', resultType: 'error' });
      expect((result as { result: string }).result).toContain('ERR wrong number of arguments');
    });

    it('should include durationMs', async () => {
      mockCall.mockResolvedValueOnce('PONG');
      const result = await service.execute('PING');
      expect((result as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('empty command', () => {
    it.each([[''], ['   ']])(
      'should return error for empty/whitespace command: "%s"',
      async (command) => {
        const result = await service.execute(command);
        expect(result.type).toBe('error');
        expect((result as { error: string }).error).toBe('Empty command');
      },
    );
  });

  describe('subcommand enforcement in safe mode', () => {
    it.each([
      ['CONFIG', 'requires a sub-command'],
      ['CLIENT', 'requires a sub-command'],
      ['SENTINEL MASTERS', 'not allowed in safe mode'],
      ['CONFIG SET maxmemory 100mb', 'not allowed in safe mode'],
    ])('should reject %s in safe mode', async (command, expectedError) => {
      const result = await service.execute(command);
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain(expectedError);
    });

    it('should allow SLOWLOG GET in safe mode', async () => {
      mockCall.mockResolvedValueOnce([]);
      const result = await service.execute('SLOWLOG GET');
      expect(result.type).toBe('result');
    });
  });

  describe('connection errors', () => {
    it('should return error when connection is not found', async () => {
      mockConnectionRegistry.get.mockImplementationOnce(() => {
        throw new NotFoundException('No connection available');
      });
      const result = await service.execute('PING');
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('No connection available');
    });
  });
});

describe('CliService (unsafe mode)', () => {
  let unsafeService: CliService;

  const mockConnectionRegistry = {
    get: jest.fn().mockImplementation(() => createMockAdapter()),
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
            get: jest.fn().mockReturnValue('true'),
          },
        },
      ],
    }).compile();

    unsafeService = module.get<CliService>(CliService);
  });

  it.each([
    ['SET foo bar', 'OK'],
    ['DEL foo', 1],
    ['CONFIG SET hz 15', 'OK'],
  ])('should allow %s in unsafe mode', async (command, mockResponse) => {
    mockCall.mockResolvedValueOnce(mockResponse);
    const result = await unsafeService.execute(command);
    expect(result.type).toBe('result');
  });

  it.each([['SUBSCRIBE channel'], ['MONITOR']])(
    'should still block %s in unsafe mode',
    async (command) => {
      const result = await unsafeService.execute(command);
      expect(result.type).toBe('error');
      expect((result as { error: string }).error).toContain('blocked');
    },
  );
});
