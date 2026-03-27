import { MigrationService } from '../migration.service';
import { NotFoundException } from '@nestjs/common';

// Mock dependencies to prevent actual analysis from running
jest.mock('../analysis/type-sampler', () => ({
  sampleKeyTypes: jest.fn().mockResolvedValue([]),
}));
jest.mock('../analysis/ttl-sampler', () => ({
  sampleTtls: jest.fn().mockResolvedValue({
    noExpiry: 0, expiresWithin1h: 0, expiresWithin24h: 0,
    expiresWithin7d: 0, expiresAfter7d: 0, sampledKeyCount: 0,
  }),
}));
jest.mock('../analysis/hfe-detector', () => ({
  detectHfe: jest.fn().mockResolvedValue({
    hfeDetected: false, hfeSupported: true, hfeKeyCount: 0,
    hfeOversizedHashesSkipped: 0, sampledHashCount: 0,
  }),
}));
jest.mock('../analysis/commandlog-analyzer', () => ({
  analyzeCommands: jest.fn().mockResolvedValue({
    sourceUsed: 'unavailable', topCommands: [],
  }),
}));

function createMockRegistry() {
  const mockClient = {
    call: jest.fn().mockResolvedValue(['default']),
    quit: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
  };
  const mockAdapter = {
    getCapabilities: jest.fn().mockReturnValue({
      dbType: 'valkey',
      version: '8.1.0',
      hasCommandLog: false,
    }),
    getInfo: jest.fn().mockResolvedValue({
      keyspace: { db0: 'keys=100,expires=0,avg_ttl=0' },
      memory: { used_memory: '1000000' },
      cluster: { cluster_enabled: '0' },
      server: {},
      persistence: { rdb_last_save_time: '0', aof_enabled: '0' },
    }),
    getClient: jest.fn().mockReturnValue(mockClient),
    getClusterNodes: jest.fn().mockResolvedValue([]),
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
    mockAdapter,
  };
}

describe('MigrationService', () => {
  let service: MigrationService;
  let registry: ReturnType<typeof createMockRegistry>;

  beforeEach(() => {
    registry = createMockRegistry();
    service = new MigrationService(registry as any);
  });

  describe('startAnalysis', () => {
    it('should return a job ID with pending status', async () => {
      const result = await service.startAnalysis({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      expect(result.id).toBeDefined();
      expect(result.status).toBe('pending');
    });

    it('should make the job retrievable via getJob', async () => {
      const { id } = await service.startAnalysis({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      const job = service.getJob(id);
      expect(job).toBeDefined();
      expect(job!.id).toBe(id);
    });

    it('should throw NotFoundException when source connection does not exist', async () => {
      registry.get.mockImplementation((id: string) => {
        if (id === 'bad') throw new NotFoundException();
        return registry.mockAdapter;
      });

      await expect(
        service.startAnalysis({
          sourceConnectionId: 'bad',
          targetConnectionId: 'conn-2',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('cancelJob', () => {
    it('should cancel a running job', async () => {
      const { id } = await service.startAnalysis({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      const success = service.cancelJob(id);
      expect(success).toBe(true);

      const job = service.getJob(id);
      expect(job!.status).toBe('cancelled');
    });

    it('should return false for unknown job ID', () => {
      const result = service.cancelJob('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getJob', () => {
    it('should return undefined for unknown job ID', () => {
      expect(service.getJob('nonexistent')).toBeUndefined();
    });
  });

  describe('job eviction', () => {
    it('should evict oldest completed jobs when MAX_JOBS reached', async () => {
      // Fill with 20 jobs (MAX_JOBS), then mark them all completed
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const { id } = await service.startAnalysis({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-2',
        });
        ids.push(id);
        // Cancel them so they are in terminal state
        service.cancelJob(id);
      }

      // Now start one more — it should trigger eviction
      const { id: newId } = await service.startAnalysis({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      // The new job should exist
      expect(service.getJob(newId)).toBeDefined();

      // At least the oldest should have been evicted
      expect(service.getJob(ids[0])).toBeUndefined();
    });
  });
});
