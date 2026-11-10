import { MigrationValidationService } from '../migration-validation.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FakeTunnels, SSH_TUNNEL, fakeEndpointResolver } from './helpers/fake-tunnels';

jest.mock('iovalkey', () => {
  const mockClient = () => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue(undefined),
    dbsize: jest.fn().mockResolvedValue(100),
    scan: jest.fn().mockResolvedValue(['0', []]),
    pipeline: jest.fn().mockReturnValue({
      type: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }),
  });
  const Valkey = jest.fn().mockImplementation(mockClient);
  (Valkey as any).Cluster = jest.fn().mockImplementation(mockClient);
  return Valkey;
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

function createMockRegistry(overrides?: { targetClusterEnabled?: boolean }) {
  const targetCluster = overrides?.targetClusterEnabled ?? false;
  const mockAdapter = {
    getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
    getInfo: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: targetCluster ? '1' : '0' } }),
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
    service = new MigrationValidationService(registry as any, storage, migrationService, fakeEndpointResolver());
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

    it('should detect cluster target and complete validation', async () => {
      const clusterRegistry = createMockRegistry({ targetClusterEnabled: true });
      const clusterStorage = createMockStorage();
      const clusterMigrationService = createMockMigrationService();
      const clusterService = new MigrationValidationService(
        clusterRegistry as any,
        clusterStorage,
        clusterMigrationService,
        fakeEndpointResolver(),
      );

      const { id } = await clusterService.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      // Wait for async validation to complete
      await new Promise(r => setTimeout(r, 100));

      const validation = clusterService.getValidation(id);
      expect(validation).toBeDefined();
      // Should query target adapter for cluster info
      expect(clusterRegistry.mockAdapter.getInfo).toHaveBeenCalledWith(['cluster']);
    });

    it('counts and samples a cluster source through a cluster client, not the seed node alone', async () => {
      const { compareKeyCounts } = jest.requireMock('../validation/key-count-comparator');
      const { validateSample } = jest.requireMock('../validation/sample-validator');
      const { Cluster } = jest.requireMock('iovalkey');
      compareKeyCounts.mockClear();
      validateSample.mockClear();
      Cluster.mockClear();

      const sourceAdapter = {
        ...registry.mockAdapter,
        getInfo: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: '1' } }),
      };
      registry.get.mockImplementation((id: string) => (id === 'conn-1' ? sourceAdapter : registry.mockAdapter));

      const { id } = await service.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });
      await new Promise(r => setTimeout(r, 100));

      expect(service.getValidation(id)!.status).toBe('completed');
      expect(Cluster).toHaveBeenCalledTimes(1);
      const sourceClusterClient = Cluster.mock.results[0].value;
      expect(compareKeyCounts).toHaveBeenCalledWith(sourceClusterClient, expect.anything(), undefined);
      expect(validateSample).toHaveBeenCalledWith(sourceClusterClient, expect.anything(), 500);
      expect(sourceClusterClient.quit).toHaveBeenCalled();
    });

    it('samples a standalone source through its own client', async () => {
      const { validateSample } = jest.requireMock('../validation/sample-validator');
      const Valkey = jest.requireMock('iovalkey');
      const { Cluster } = Valkey;
      validateSample.mockClear();
      Valkey.mockClear();
      Cluster.mockClear();

      const { id } = await service.startValidation({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });
      await new Promise(r => setTimeout(r, 100));

      expect(service.getValidation(id)!.status).toBe('completed');
      expect(Cluster).not.toHaveBeenCalled();
      // createClient(source) is the first standalone client the job builds.
      const sourceClient = Valkey.mock.results[0].value;
      expect(validateSample).toHaveBeenCalledWith(sourceClient, expect.anything(), 500);
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

describe('MigrationValidationService with external connections', () => {
  const EXTERNAL_MESSAGE =
    'One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances.';

  it.each([
    ['source', 'conn-1'],
    ['target', 'conn-2'],
  ])('rejects an external %s before creating a validation job', async (_side, externalId) => {
    const registry = createMockRegistry();
    registry.getConfig.mockImplementation((id: string) => ({
      id,
      name: id,
      host: '127.0.0.1',
      port: 6379,
      createdAt: Date.now(),
      connectionType: id === externalId ? 'external' : 'direct',
    }));
    const service = new MigrationValidationService(registry as any, createMockStorage(), createMockMigrationService(), fakeEndpointResolver());
    const runValidation = jest.spyOn(service as unknown as { runValidation: () => Promise<void> }, 'runValidation');

    const error = await service
      .startValidation({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(EXTERNAL_MESSAGE);

    expect(runValidation).not.toHaveBeenCalled();
    expect(registry.mockAdapter.getClient).not.toHaveBeenCalled();
    expect((service as unknown as { jobs: Map<string, unknown> }).jobs.size).toBe(0);
  });
});

describe('MigrationValidationService with SSH-tunneled connections', () => {
  const Valkey = require('iovalkey') as jest.Mock;
  const { compareKeyCounts } = require('../validation/key-count-comparator');

  function setup(tunnelledIds: string[], overrides?: { targetClusterEnabled?: boolean; agentId?: string }) {
    const registry = createMockRegistry(overrides);
    registry.getConfig.mockImplementation((id: string) => ({
      id,
      name: id,
      host: id === overrides?.agentId ? 'agent' : id === 'conn-1' ? 'src.internal' : 'tgt.internal',
      port: 6379,
      createdAt: Date.now(),
      ...(tunnelledIds.includes(id) ? { sshTunnel: SSH_TUNNEL } : {}),
    }));
    const tunnels = new FakeTunnels();
    const service = new MigrationValidationService(registry as any, createMockStorage(), createMockMigrationService(), fakeEndpointResolver(tunnels));
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return { service, tunnels };
  }

  async function waitForTerminal(service: MigrationValidationService, id: string) {
    for (let i = 0; i < 200; i++) {
      const job = service.getValidation(id);
      if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('validation did not finish');
  }

  beforeEach(() => Valkey.mockClear());

  it('dials the local tunnel port for a tunnelled source and closes the tunnel when the job ends', async () => {
    const { service, tunnels } = setup(['conn-1']);

    const { id } = await service.startValidation({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
    const job = await waitForTerminal(service, id);

    const dialled = Valkey.mock.calls.map(([options]) => `${options.connectionName}@${options.host}:${options.port}`);
    expect(dialled).toEqual(['BetterDB-Validation-Source@127.0.0.1:40001', 'BetterDB-Validation-Target@tgt.internal:6379']);
    expect(tunnels.opened.get(`migration:${id}:source`)).toMatchObject({ remoteHost: 'src.internal', remotePort: 6379 });
    expect(job.status).toBe('completed');
    expect(tunnels.closed).toEqual([`migration:${id}:source`]);
  });

  it('fails the job with the cluster message for a tunnelled cluster target, without opening a tunnel', async () => {
    const { service, tunnels } = setup(['conn-1', 'conn-2'], { targetClusterEnabled: true });

    const { id } = await service.startValidation({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
    const job = await waitForTerminal(service, id);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/cluster reached through an SSH tunnel/);
    expect(tunnels.opened.size).toBe(0);
    expect(Valkey).not.toHaveBeenCalled();
  });

  it('fails the job with a clear message when a tunnel cannot be opened', async () => {
    const { service, tunnels } = setup(['conn-1']);
    tunnels.failFor = 'source';

    const { id } = await service.startValidation({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
    const job = await waitForTerminal(service, id);

    expect(job.status).toBe('failed');
    expect(job.error).toBe('Could not open the SSH tunnel to the source: All configured authentication methods failed');
  });

  it('fails the job with the tunnel message when a tunnel drops mid-run', async () => {
    const { service, tunnels } = setup(['conn-2']);
    compareKeyCounts.mockImplementationOnce(async () => {
      tunnels.drop('target');
      return { sourceKeys: 100, targetKeys: 100, discrepancy: 0, discrepancyPercent: 0 };
    });

    const { id } = await service.startValidation({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
    const job = await waitForTerminal(service, id);

    expect(job.status).toBe('failed');
    expect(job.error).toBe('The SSH tunnel to the target closed unexpectedly');
    expect(tunnels.closed).toEqual([`migration:${id}:target`]);
  });

  it('rejects an agent connection before creating a validation job', async () => {
    const { service } = setup([], { agentId: 'conn-2' });

    const error = await service
      .startValidation({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toMatch(/connected through the BetterDB Agent/);
    expect((service as unknown as { jobs: Map<string, unknown> }).jobs.size).toBe(0);
  });
});
