import { MigrationValidationService } from '../migration-validation.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

jest.mock('iovalkey', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue(undefined),
    dbsize: jest.fn().mockResolvedValue(100),
    scan: jest.fn().mockResolvedValue(['0', []]),
    pipeline: jest.fn().mockReturnValue({
      type: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }),
  }));
});

jest.mock('../validation/key-count-comparator', () => ({
  compareKeyCounts: jest.fn().mockResolvedValue({
    sourceKeys: 100,
    targetKeys: 100,
    discrepancy: 0,
    discrepancyPercent: 0,
  }),
}));

jest.mock('../validation/sample-validator', () => ({
  validateSample: jest.fn().mockResolvedValue({
    sampledKeys: 100,
    matched: 100,
    missing: 0,
    typeMismatches: 0,
    valueMismatches: 0,
    issues: [],
  }),
}));

jest.mock('../validation/baseline-comparator', () => ({
  compareBaseline: jest.fn().mockResolvedValue({
    available: true,
    snapshotCount: 10,
    baselineWindowMs: 3600000,
    metrics: [],
  }),
}));

function createMockRegistry() {
  const mockAdapter = {
    getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
    getInfo: jest.fn().mockResolvedValue({}),
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
    mockAdapter,
  };
}

function createMockStorage() {
  return {
    getSnapshots: jest.fn().mockResolvedValue([]),
    getLatestSnapshot: jest.fn().mockResolvedValue(null),
  } as any;
}

function createMockMigrationService() {
  return {
    getJob: jest.fn().mockReturnValue(undefined),
  } as any;
}

describe('MigrationValidationService', () => {
  let service: MigrationValidationService;
  let registry: ReturnType<typeof createMockRegistry>;
  let storage: ReturnType<typeof createMockStorage>;
  let migrationService: ReturnType<typeof createMockMigrationService>;

  beforeEach(() => {
    registry = createMockRegistry();
    storage = createMockStorage();
    migrationService = createMockMigrationService();
    service = new MigrationValidationService(registry as any, storage, migrationService);
  });

  describe('startValidation', () => {
    it('should return a job ID with pending status', async () => {
      const result = await service.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      expect(result.id).toBeDefined();
      expect(result.status).toBe('pending');
    });

    it('should make the job retrievable via getValidation', async () => {
      const { id } = await service.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      const validation = service.getValidation(id);
      expect(validation).toBeDefined();
      expect(validation!.id).toBe(id);
    });

    it('should reject same source and target', async () => {
      await expect(
        service.startValidation({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when connection does not exist', async () => {
      registry.get.mockImplementation((id: string) => {
        if (id === 'missing') throw new NotFoundException();
        return registry.mockAdapter;
      });

      await expect(
        service.startValidation({
          sourceConnectionId: 'missing',
          targetConnectionId: 'conn-2',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should use Phase 1 analysis result when analysisId provided', async () => {
      migrationService.getJob.mockReturnValue({
        status: 'completed',
        dataTypeBreakdown: { string: { count: 50 } },
      });

      const { id } = await service.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        analysisId: 'analysis-1',
      });

      expect(migrationService.getJob).toHaveBeenCalledWith('analysis-1');
      expect(service.getValidation(id)).toBeDefined();
    });
  });

  describe('cancelValidation', () => {
    it('should cancel a running validation', async () => {
      const { id } = await service.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      const result = service.cancelValidation(id);
      expect(result).toBe(true);

      const validation = service.getValidation(id);
      expect(validation!.status).toBe('cancelled');
      expect(validation!.error).toBe('Cancelled by user');
    });

    it('should return false for unknown job ID', () => {
      expect(service.cancelValidation('nonexistent')).toBe(false);
    });

    it('should be idempotent for terminal states', async () => {
      const { id } = await service.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      // Wait a tick for the job to potentially complete
      await new Promise(r => setTimeout(r, 50));

      const validation = service.getValidation(id);
      if (validation!.status === 'completed' || validation!.status === 'failed') {
        expect(service.cancelValidation(id)).toBe(true);
      }
    });
  });

  describe('getValidation', () => {
    it('should return undefined for unknown job ID', () => {
      expect(service.getValidation('nonexistent')).toBeUndefined();
    });
  });

  describe('job eviction', () => {
    it('should evict oldest jobs when MAX_JOBS (10) reached', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { id } = await service.startValidation({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-2',
        });
        ids.push(id);
        // Cancel to put in terminal state
        service.cancelValidation(id);
      }

      const { id: newId } = await service.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      expect(service.getValidation(newId)).toBeDefined();
      expect(service.getValidation(ids[0])).toBeUndefined();
    });
  });
});
