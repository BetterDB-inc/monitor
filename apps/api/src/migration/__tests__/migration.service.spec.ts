import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MigrationService } from '../migration.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { probeTargetCapacity } from '../analysis/capacity-checker';

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
jest.mock('../analysis/capacity-checker', () => ({
  ...jest.requireActual('../analysis/capacity-checker'),
  probeTargetCapacity: jest.fn().mockResolvedValue([]),
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

describe('MigrationService capacity preflight', () => {
  const probe = probeTargetCapacity as jest.MockedFunction<typeof probeTargetCapacity>;
  const OLD_VERDICT_DIR = process.env.MIGRATION_VERDICT_DIR;
  let verdictDir: string;

  beforeEach(() => {
    verdictDir = mkdtempSync(join(tmpdir(), 'verdicts-'));
    process.env.MIGRATION_VERDICT_DIR = verdictDir;
    probe.mockReset();
  });

  afterEach(() => {
    rmSync(verdictDir, { recursive: true, force: true });
    if (OLD_VERDICT_DIR === undefined) delete process.env.MIGRATION_VERDICT_DIR;
    else process.env.MIGRATION_VERDICT_DIR = OLD_VERDICT_DIR;
  });

  async function analyze(usedMemory?: string) {
    const mock = createMockRegistry();
    if (usedMemory) {
      mock.mockAdapter.getInfo.mockResolvedValue({
        ...(await mock.mockAdapter.getInfo()),
        memory: { used_memory: usedMemory },
      });
    }
    const registry = mock as unknown as ConstructorParameters<typeof MigrationService>[0];
    const service = new MigrationService(registry);
    const { id } = await service.startAnalysis({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
    for (let i = 0; i < 100 && service.getJob(id)?.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return service.getJob(id)!;
  }

  it('adds the probe issues to the analysis and counts a capacity blocker', async () => {
    probe.mockResolvedValue([
      { severity: 'blocking', category: 'capacity', title: 'Target does not have enough memory', detail: 'd' },
      { severity: 'warning', category: 'key_overlap', title: 'Source keys already exist on the target', detail: 'd' },
    ]);

    const job = await analyze();

    expect(job.status).toBe('completed');
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        targetIsCluster: false,
        sourceBytes: 1000000,
        roughSourceSize: true,
        sampledKeys: [],
        sourceExpiringKeys: 0,
      }),
    );
    expect(job.incompatibilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'capacity', severity: 'blocking' })]),
    );
    expect(job.blockingCount).toBe(1);
    expect(job.warningCount).toBeGreaterThanOrEqual(1);
  });

  it('sizes the source by its used_memory and flags it rough when sampling gave no estimate', async () => {
    probe.mockResolvedValue([]);

    const job = await analyze('5000000');

    expect(job.totalMemoryBytes).toBe(5000000);
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBytes: 5000000, roughSourceSize: true }),
    );
  });

  it('reports that the preflight did not run when the target cannot be probed', async () => {
    probe.mockRejectedValue(new Error('NOPERM this user has no permissions to run the info command'));

    const job = await analyze();

    expect(job.status).toBe('completed');
    expect(job.blockingCount).toBe(0);
    expect(job.incompatibilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'info',
          category: 'capacity',
          title: 'Capacity and key-overlap checks did not run',
        }),
      ]),
    );
    expect(
      job.incompatibilities?.find((i) => i.title === 'Capacity and key-overlap checks did not run')?.detail,
    ).toContain('NOPERM');
  });
});

describe('MigrationService with external connections', () => {
  const EXTERNAL_MESSAGE =
    'One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances.';

  it.each([
    ['source', 'conn-1'],
    ['target', 'conn-2'],
  ])('rejects an external %s before creating an analysis job', async (_side, externalId) => {
    const registry = createMockRegistry();
    registry.getConfig.mockImplementation((id: string) => ({
      id,
      name: id,
      host: '127.0.0.1',
      port: 6379,
      createdAt: Date.now(),
      connectionType: id === externalId ? 'external' : 'direct',
    }));
    const service = new MigrationService(registry as any);
    const runAnalysis = jest.spyOn(service as unknown as { runAnalysis: () => Promise<void> }, 'runAnalysis');

    const error = await service
      .startAnalysis({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(EXTERNAL_MESSAGE);
    expect(runAnalysis).not.toHaveBeenCalled();
    expect(registry.mockAdapter.getClient).not.toHaveBeenCalled();
    expect((service as unknown as { jobs: Map<string, unknown> }).jobs.size).toBe(0);
  });
});
