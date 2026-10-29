import { MigrationService } from '../migration.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

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
  collectCommandAnalysis: jest.fn().mockResolvedValue({
    analysis: { sourceUsed: 'slowlog', topCommands: [] },
    entries: [],
  }),
  collectNodeCommandEntries: jest.fn().mockResolvedValue({ entries: [], unreadNodes: 0 }),
}));

type MockNodeClient = {
  host: string;
  port: number;
  options: Record<string, unknown>;
  connect: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  dbsize: jest.Mock;
  info: jest.Mock;
  call: jest.Mock;
};
const nodeClients: MockNodeClient[] = [];
let unreachableHosts = new Set<string>();
let stalledHosts = new Set<string>();

jest.mock('iovalkey', () => jest.fn().mockImplementation((opts: { host: string; port: number }) => {
  const client: MockNodeClient = {
    host: opts.host,
    port: opts.port,
    options: opts,
    connect: jest.fn().mockImplementation(() => {
      if (stalledHosts.has(opts.host)) return new Promise<void>(() => undefined);
      if (unreachableHosts.has(opts.host)) return Promise.reject(new Error('connect ECONNREFUSED'));
      return Promise.resolve();
    }),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    dbsize: jest.fn().mockResolvedValue(10),
    info: jest.fn().mockResolvedValue('# Memory\r\nused_memory:1000\r\n'),
    call: jest.fn().mockImplementation(async (...args: string[]) => (args[0] === 'FUNCTION' ? [] : '')),
  };
  nodeClients.push(client);
  return client;
}));
jest.mock('../analysis/analysis-verdict-store', () => ({
  resolveVerdictDir: jest.fn().mockReturnValue('/nonexistent/verdicts'),
  saveAnalysisVerdict: jest.fn(),
  loadAnalysisVerdict: jest.fn().mockReturnValue(undefined),
}));

import type { Incompatibility, MigrationAnalysisResult } from '@betterdb/shared';
import { saveAnalysisVerdict } from '../analysis/analysis-verdict-store';

function createMockRegistry() {
  const mockClient = {
    call: jest.fn().mockImplementation(async (...args: string[]) => (args[0] === 'FUNCTION' ? [] : ['default'])),
    quit: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    info: jest.fn().mockResolvedValue('# Stats\r\npubsub_channels:0\r\npubsub_patterns:0\r\npubsubshard_channels:0\r\n'),
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
    isServerlessAgentConnection: jest.fn().mockReturnValue(false),
    mockAdapter,
    mockClient,
  };
}

async function waitForTerminal(service: MigrationService, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = service.getJob(id);
    if (job && job.status !== 'pending' && job.status !== 'running') return job;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('analysis did not finish');
}

function readyReplicationCommands(registry: ReturnType<typeof createMockRegistry>) {
  registry.mockClient.call.mockImplementation(async (...args: string[]) => {
    if (args[0] === 'COMMAND' && args[1] === 'INFO') return [['psync'], ['replconf']];
    if (args[0] === 'FUNCTION') return [];
    return ['default'];
  });
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

describe('MigrationService ElastiCache Serverless readiness', () => {
  beforeEach(() => {
    jest.mocked(saveAnalysisVerdict).mockClear();
  });

  function serverlessCategory(job: MigrationAnalysisResult): Incompatibility[] {
    return (job.incompatibilities ?? []).filter(i => i.category === 'serverless_readiness');
  }

  it('adds serverless readiness issues when the target endpoint is ElastiCache Serverless', async () => {
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    registry.getConfig.mockImplementation((id: string) => ({
      id,
      name: id,
      host: id === 'conn-2' ? 'my-cache-x1y2z3.serverless.use1.cache.amazonaws.com' : '127.0.0.1',
      port: 6379,
      createdAt: Date.now(),
    }));
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
    const job = await waitForTerminal(service, id);

    expect(job.status).toBe('completed');
    expect(serverlessCategory(job).map(i => i.title)).toEqual(['Standalone source']);
  });

  it('adds serverless readiness issues when the target agent reported AWS_SERVERLESS', async () => {
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    registry.isServerlessAgentConnection.mockImplementation((id: string) => id === 'conn-2');
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
    const job = await waitForTerminal(service, id);

    expect(serverlessCategory(job)).toHaveLength(1);
    expect(job.targetConnectionId).toBe('conn-2');
    expect(job.targetProfile).toBe('elasticache_serverless');
  });

  it('flags keys outside db0 in a profile-only Serverless check', async () => {
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    registry.mockAdapter.getInfo.mockResolvedValue({
      keyspace: { db0: 'keys=100,expires=0,avg_ttl=0', db3: 'keys=5,expires=0,avg_ttl=0' },
      memory: { used_memory: '1000000' },
      cluster: { cluster_enabled: '0' },
      server: {},
      persistence: {},
    });
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({
      sourceConnectionId: 'conn-1',
      targetProfile: 'elasticache_serverless',
    });
    const job = await waitForTerminal(service, id);

    expect(serverlessCategory(job).map(i => i.title)).toContain('Keys outside database 0');
  });

  it('flags function libraries in a Serverless check', async () => {
    const registry = createMockRegistry();
    registry.mockClient.call.mockImplementation(async (...args: string[]) => {
      if (args[0] === 'COMMAND' && args[1] === 'INFO') return [['psync'], ['replconf']];
      if (args[0] === 'FUNCTION' && args[1] === 'LIST') return [['library_name', 'mylib']];
      return ['default'];
    });
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({
      sourceConnectionId: 'conn-1',
      targetProfile: 'elasticache_serverless',
    });
    const job = await waitForTerminal(service, id);

    expect(serverlessCategory(job).map(i => i.title)).toContain('Function libraries on the source');
  });

  it('reads the cached script count from the INFO memory already fetched for the source', async () => {
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    registry.mockAdapter.getInfo.mockResolvedValue({
      keyspace: { db0: 'keys=100,expires=0,avg_ttl=0' },
      memory: { used_memory: '1000000', number_of_cached_scripts: '4' },
      cluster: { cluster_enabled: '0' },
      server: {},
      persistence: {},
    });
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({
      sourceConnectionId: 'conn-1',
      targetProfile: 'elasticache_serverless',
    });
    const job = await waitForTerminal(service, id);

    expect(serverlessCategory(job).map(i => i.title)).toContain('Scripts in the script cache');
  });

  it('adds no serverless readiness issues for an ordinary target', async () => {
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
    const job = await waitForTerminal(service, id);

    expect(job.status).toBe('completed');
    expect(serverlessCategory(job)).toEqual([]);
    expect(job.targetProfile).toBeUndefined();
  });

  it('does not report missing replication commands when COMMAND INFO is refused', async () => {
    const registry = createMockRegistry();
    registry.mockClient.call.mockImplementation(async (...args: string[]) => {
      if (args[0] === 'COMMAND') throw new Error('NOPERM');
      if (args[0] === 'FUNCTION') return [];
      return ['default'];
    });
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({
      sourceConnectionId: 'conn-1',
      targetProfile: 'elasticache_serverless',
    });
    const job = await waitForTerminal(service, id);

    expect(job.status).toBe('completed');
    expect(serverlessCategory(job).map(i => i.title)).toEqual(['Standalone source', 'Some readiness checks could not run']);
  });

  it('notes that the restricted-command check could not run when no command log is readable', async () => {
    const { collectCommandAnalysis } = jest.requireMock('../analysis/commandlog-analyzer') as { collectCommandAnalysis: jest.Mock };
    collectCommandAnalysis.mockResolvedValueOnce({ analysis: { sourceUsed: 'unavailable', topCommands: [] }, entries: [] });
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({ sourceConnectionId: 'conn-1', targetProfile: 'elasticache_serverless' });
    const job = await waitForTerminal(service, id);

    const notice = serverlessCategory(job).find(i => i.title === 'Some readiness checks could not run');
    expect(notice?.detail).toContain('COMMANDLOG and SLOWLOG could not be read on 1 node');
  });

  it('reports PSYNC missing when COMMAND INFO returns nil for it', async () => {
    const registry = createMockRegistry();
    registry.mockClient.call.mockImplementation(async (...args: string[]) => {
      if (args[0] === 'COMMAND' && args[1] === 'INFO') return [null, ['replconf']];
      if (args[0] === 'FUNCTION') return [];
      return ['default'];
    });
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({
      sourceConnectionId: 'conn-1',
      targetProfile: 'elasticache_serverless',
    });
    const job = await waitForTerminal(service, id);

    const replication = serverlessCategory(job).find(i => i.title === 'Replication commands unavailable');
    expect(replication).toBeDefined();
    expect(replication!.detail).toContain('PSYNC');
    expect(replication!.detail).not.toContain('REPLCONF is');
  });

  it('reads pub/sub counts from INFO stats without fetching INFO memory again', async () => {
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    const info = jest.fn(async (section: string) => {
      if (section === 'stats') return '# Stats\r\npubsub_channels:2\r\npubsub_patterns:0\r\npubsubshard_channels:1\r\n';
      return '';
    });
    (registry.mockClient as Record<string, unknown>).info = info;
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({
      sourceConnectionId: 'conn-1',
      targetProfile: 'elasticache_serverless',
    });
    const job = await waitForTerminal(service, id);

    const titles = serverlessCategory(job).map(i => i.title);
    expect(titles).toContain('Pub/sub subscribers present');
    expect(info).not.toHaveBeenCalledWith('memory');
  });

  describe('standalone check against ElastiCache Serverless', () => {
    it('runs without a target connection and only reports serverless readiness', async () => {
      const registry = createMockRegistry();
      readyReplicationCommands(registry);
      const service = new MigrationService(registry as any);

      const { id } = await service.startAnalysis({
        sourceConnectionId: 'conn-1',
        targetProfile: 'elasticache_serverless',
      });
      const job = await waitForTerminal(service, id);

      expect(job.status).toBe('completed');
      expect(registry.get).not.toHaveBeenCalledWith(undefined);
      expect(registry.getConfig).not.toHaveBeenCalledWith(undefined);
      expect(job.targetConnectionId).toBeUndefined();
      expect(job.targetProfile).toBe('elasticache_serverless');
      expect(job.incompatibilities!.length).toBeGreaterThan(0);
      expect(job.incompatibilities!.every(i => i.category === 'serverless_readiness')).toBe(true);
      expect(job.warningCount).toBe(1);
    });

    it('persists no verdict and cannot be found as the latest analysis for a pair', async () => {
      const registry = createMockRegistry();
      readyReplicationCommands(registry);
      const service = new MigrationService(registry as any);

      const { id } = await service.startAnalysis({
        sourceConnectionId: 'conn-1',
        targetProfile: 'elasticache_serverless',
      });
      await waitForTerminal(service, id);

      expect(saveAnalysisVerdict).not.toHaveBeenCalled();
      expect(service.findLatestCompletedAnalysis('conn-1', 'conn-2')).toBeUndefined();
    });

    it('still persists a verdict for an analysis with a target', async () => {
      const registry = createMockRegistry();
      readyReplicationCommands(registry);
      const service = new MigrationService(registry as any);

      const { id } = await service.startAnalysis({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' });
      await waitForTerminal(service, id);

      expect(saveAnalysisVerdict).toHaveBeenCalledTimes(1);
    });

    it('rejects a source that cannot be migrated before creating a job', async () => {
      const registry = createMockRegistry();
      registry.getConfig.mockReturnValue({
        id: 'conn-1', name: 'x', host: '127.0.0.1', port: 6379, createdAt: Date.now(), connectionType: 'external',
      });
      const service = new MigrationService(registry as any);

      await expect(
        service.startAnalysis({ sourceConnectionId: 'conn-1', targetProfile: 'elasticache_serverless' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

describe('MigrationService cluster analysis', () => {
  beforeEach(() => {
    nodeClients.length = 0;
    unreachableHosts = new Set();
    stalledHosts = new Set();
  });

  afterEach(() => jest.useRealTimers());

  it('reports a slot-owning master with an unusable address as unreachable', async () => {
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    registry.mockAdapter.getInfo.mockResolvedValue({
      keyspace: { db0: 'keys=100,expires=0,avg_ttl=0' },
      memory: { used_memory: '1000000' },
      cluster: { cluster_enabled: '1' },
      server: {},
      persistence: {},
    });
    registry.mockAdapter.getClusterNodes.mockResolvedValue([
      { id: 'a', address: '10.0.0.1:6379@16379', flags: ['master'], slots: [[0, 5000]] },
      { id: 'b', address: '10.0.0.2:abc@16379', flags: ['master'], slots: [[5001, 10000]] },
      { id: 'node-c', address: '', flags: ['master'], slots: [[10001, 16383]] },
    ]);
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({ sourceConnectionId: 'conn-1', targetProfile: 'elasticache_serverless' });
    const job = await waitForTerminal(service, id);

    const unreachable = (job.incompatibilities ?? []).find(i => i.title === 'Source master unreachable');
    expect(unreachable?.detail).toContain('10.0.0.2:abc@16379');
    expect(unreachable?.detail).toContain('node-c');
    expect(unreachable?.detail).not.toContain('10.0.0.1');
  });

  it('reports a master whose connect never settles as unreachable', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    registry.mockAdapter.getInfo.mockResolvedValue({
      keyspace: { db0: 'keys=100,expires=0,avg_ttl=0' },
      memory: { used_memory: '1000000' },
      cluster: { cluster_enabled: '1' },
      server: {},
      persistence: {},
    });
    registry.mockAdapter.getClusterNodes.mockResolvedValue([
      { id: 'a', address: '10.0.0.1:6379@16379', flags: ['master'], slots: [[0, 8191]] },
      { id: 'b', address: '10.0.0.2:6379@16379', flags: ['master'], slots: [[8192, 16383]] },
    ]);
    stalledHosts = new Set(['10.0.0.2']);
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({
      sourceConnectionId: 'conn-1',
      targetProfile: 'elasticache_serverless',
    });
    let job = service.getJob(id)!;
    for (let i = 0; i < 400 && (job.status === 'pending' || job.status === 'running'); i++) {
      jest.advanceTimersByTime(1000);
      await new Promise(resolve => setImmediate(resolve));
      job = service.getJob(id)!;
    }

    expect(job.status).toBe('completed');
    const unreachable = (job.incompatibilities ?? []).filter(i => i.title === 'Source master unreachable');
    expect(unreachable.map(i => i.detail).join()).toContain('10.0.0.2:6379');
    const stalled = nodeClients.find(c => c.host === '10.0.0.2')!;
    expect(stalled.disconnect).toHaveBeenCalled();
    expect((stalled.options.retryStrategy as () => unknown)()).toBeNull();
    expect(stalled.options.connectTimeout).toEqual(expect.any(Number));
  });

  it('reports an unreachable master as a warning and still cleans up its client', async () => {
    const registry = createMockRegistry();
    readyReplicationCommands(registry);
    registry.mockAdapter.getInfo.mockResolvedValue({
      keyspace: { db0: 'keys=100,expires=0,avg_ttl=0' },
      memory: { used_memory: '1000000' },
      cluster: { cluster_enabled: '1' },
      server: {},
      persistence: {},
    });
    registry.mockAdapter.getClusterNodes.mockResolvedValue([
      { id: 'a', address: '10.0.0.1:6379@16379', flags: ['master'], slots: [[0, 8191]] },
      { id: 'b', address: '10.0.0.2:6379@16379', flags: ['master'], slots: [[8192, 16383]] },
    ]);
    unreachableHosts = new Set(['10.0.0.2']);
    const service = new MigrationService(registry as any);

    const { id } = await service.startAnalysis({
      sourceConnectionId: 'conn-1',
      targetProfile: 'elasticache_serverless',
    });
    const job = await waitForTerminal(service, id);

    expect(job.status).toBe('completed');
    const unreachable = (job.incompatibilities ?? []).filter(i => i.title === 'Source master unreachable');
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].severity).toBe('warning');
    expect(unreachable[0].detail).toContain('10.0.0.2:6379');
    expect(unreachable[0].detail).not.toContain('10.0.0.1:6379');
    const failed = nodeClients.find(c => c.host === '10.0.0.2')!;
    expect(failed.disconnect).toHaveBeenCalled();
    expect(failed.dbsize).not.toHaveBeenCalled();
    expect(failed.quit).toHaveBeenCalled();
    expect(nodeClients.find(c => c.host === '10.0.0.1')!.dbsize).toHaveBeenCalled();
  });
});
