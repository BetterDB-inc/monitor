import { MigrationExecutionService } from '../migration-execution.service';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

jest.mock('../execution/redisshake-runner', () => ({
  findRedisShakeBinary: jest.fn().mockReturnValue('/usr/local/bin/redis-shake'),
}));

jest.mock('../execution/toml-builder', () => ({
  buildScanReaderToml: jest.fn().mockReturnValue('[scan_reader]\naddress = "127.0.0.1:6379"\n'),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn().mockReturnValue({
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn().mockImplementation((event: string, cb: (code: number) => void) => {
      if (event === 'exit') setTimeout(() => cb(0), 10);
    }),
    kill: jest.fn(),
    pid: 12345,
  }),
}));

jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true),
}));

jest.mock('../execution/command-migration-worker', () => ({
  runCommandMigration: jest.fn().mockResolvedValue(undefined),
}));

function createMockRegistry() {
  const mockAdapter = {
    getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
    getInfo: jest.fn().mockResolvedValue({ cluster_enabled: '0' }),
    getClient: jest.fn().mockReturnValue({ quit: jest.fn() }),
  };
  return {
    get: jest.fn().mockReturnValue(mockAdapter),
    getConfig: jest.fn().mockReturnValue({
      id: 'conn-1',
      name: 'Test',
      host: '127.0.0.1',
      port: 6379,
      createdAt: Date.now(),
    }),
  };
}

describe('MigrationExecutionService', () => {
  let service: MigrationExecutionService;
  let registry: ReturnType<typeof createMockRegistry>;

  beforeEach(() => {
    registry = createMockRegistry();
    service = new MigrationExecutionService(registry as any);
  });

  describe('startExecution', () => {
    it('should return a job ID with pending status', async () => {
      const result = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      expect(result.id).toBeDefined();
      expect(result.status).toBe('pending');
    });

    it('should make the job retrievable via getExecution', async () => {
      const { id } = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      const exec = service.getExecution(id);
      expect(exec).toBeDefined();
      expect(exec!.id).toBe(id);
    });

    it('should reject same source and target', async () => {
      await expect(
        service.startExecution({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when connection does not exist', async () => {
      registry.get.mockImplementation((id: string) => {
        if (id === 'missing') throw new NotFoundException();
        return { getCapabilities: jest.fn(), getInfo: jest.fn().mockResolvedValue({}), getClient: jest.fn() };
      });

      await expect(
        service.startExecution({
          sourceConnectionId: 'missing',
          targetConnectionId: 'conn-2',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('stopExecution', () => {
    it('should cancel a running job', async () => {
      const { id } = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      const result = service.stopExecution(id);
      expect(result).toBe(true);

      const exec = service.getExecution(id);
      expect(exec!.status).toBe('cancelled');
    });

    it('should return false for unknown job ID', () => {
      expect(service.stopExecution('nonexistent')).toBe(false);
    });

    it('should be idempotent for terminal states', async () => {
      const { id } = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });
      service.stopExecution(id);

      // Call again — should still return true
      expect(service.stopExecution(id)).toBe(true);
    });
  });

  describe('getExecution', () => {
    it('should return undefined for unknown job ID', () => {
      expect(service.getExecution('nonexistent')).toBeUndefined();
    });
  });

  describe('job eviction', () => {
    it('should evict oldest completed jobs when MAX_JOBS (10) reached', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { id } = await service.startExecution({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-2',
        });
        ids.push(id);
        service.stopExecution(id); // Mark as cancelled (terminal)
      }

      // One more should trigger eviction
      const { id: newId } = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      expect(service.getExecution(newId)).toBeDefined();
      // Oldest should be evicted
      expect(service.getExecution(ids[0])).toBeUndefined();
    });
  });
});
