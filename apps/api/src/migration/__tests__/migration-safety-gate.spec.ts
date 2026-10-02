import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MigrationService } from '../migration.service';
import { MigrationExecutionService } from '../migration-execution.service';
import {
  loadAnalysisVerdict,
  resolveVerdictDir,
  saveAnalysisVerdict,
} from '../analysis/analysis-verdict-store';

jest.mock('../execution/redisshake-runner', () => ({
  findRedisShakeBinary: jest.fn().mockReturnValue('/usr/local/bin/redis-shake'),
}));

jest.mock('../execution/toml-builder', () => ({
  buildScanReaderToml: jest.fn().mockReturnValue('[scan_reader]\n'),
  buildSyncReaderToml: jest.fn().mockReturnValue('[sync_reader]\n'),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn().mockReturnValue({
    stdout: { on: jest.fn(), setEncoding: jest.fn() },
    stderr: { on: jest.fn(), setEncoding: jest.fn() },
    on: jest.fn().mockImplementation((event: string, cb: (code: number) => void) => {
      if (event === 'exit') setTimeout(() => cb(0), 10);
      if (event === 'close') setTimeout(() => cb(0), 20);
    }),
    kill: jest.fn(),
    pid: 12345,
  }),
}));

jest.mock('../execution/command-migration-worker', () => ({
  runCommandMigration: jest.fn().mockResolvedValue(undefined),
}));

function mockRegistry() {
  const mk = () => ({
    getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
    getInfo: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: '0' } }),
    getClient: jest.fn().mockReturnValue({ call: jest.fn().mockResolvedValue([]), quit: jest.fn() }),
  });
  const adapters: Record<string, unknown> = { 'conn-1': mk(), 'conn-2': mk() };
  return {
    get: jest.fn().mockImplementation((id: string) => adapters[id]),
    getConfig: jest.fn().mockReturnValue({
      id: 'x',
      name: 't',
      host: '127.0.0.1',
      port: 6379,
      createdAt: Date.now(),
    }),
  };
}

function seedCompletedJob(
  service: MigrationService,
  opts: { id: string; source: string; target: string; completedAt: number; blocking?: boolean },
) {
  const jobs = (service as any).jobs as Map<string, any>;
  jobs.set(opts.id, {
    id: opts.id,
    status: 'completed',
    progress: 100,
    createdAt: opts.completedAt - 1000,
    completedAt: opts.completedAt,
    cancelled: false,
    nodeClients: [],
    result: {
      id: opts.id,
      status: 'completed',
      progress: 100,
      createdAt: opts.completedAt - 1000,
      completedAt: opts.completedAt,
      sourceConnectionId: opts.source,
      targetConnectionId: opts.target,
      incompatibilities: opts.blocking
        ? [{ severity: 'blocking', category: 'hfe', title: 'HFE', detail: 'nope' }]
        : [],
      blockingCount: opts.blocking ? 1 : 0,
      warningCount: 0,
    },
  });
}

describe('migration safety gate regressions', () => {
  const OLD_ENV = process.env.MIGRATION_VERDICT_DIR;
  let verdictDir: string;

  beforeEach(() => {
    verdictDir = mkdtempSync(join(tmpdir(), 'verdicts-'));
    process.env.MIGRATION_VERDICT_DIR = verdictDir;
  });

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.MIGRATION_VERDICT_DIR;
    else process.env.MIGRATION_VERDICT_DIR = OLD_ENV;
    rmSync(verdictDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('P1-1 fail-closed: missing MigrationService blocks instead of silently skipping', async () => {
    const svc = new MigrationExecutionService(mockRegistry() as any, undefined as any);
    await expect(
      svc.startExecution({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('P1-1: production path requires analysis (no silent success)', async () => {
    const svc = new MigrationExecutionService(
      mockRegistry() as any,
      { findLatestCompletedAnalysis: () => undefined } as any,
    );
    const err = await svc
      .startExecution({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' })
      .catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err.getResponse() as any).code).toBe('ANALYSIS_REQUIRED');
  });

  it('P1-2 restart: file verdict survives a fresh service with empty memory', () => {
    expect(resolveVerdictDir()).toBe(verdictDir);
    const now = Date.now();
    saveAnalysisVerdict(verdictDir, {
      analysisId: 'a-restart',
      sourceConnectionId: 'conn-1',
      targetConnectionId: 'conn-2',
      completedAt: now,
      createdAt: now - 1000,
      incompatibilities: [],
      blockingCount: 0,
      warningCount: 0,
    });

    // Simulate restart: brand-new service, empty in-memory Map.
    const restarted = new MigrationService({} as any);
    const found = restarted.findLatestCompletedAnalysis('conn-1', 'conn-2');
    expect(found).toBeDefined();
    expect(found!.id).toBe('a-restart');
    expect(loadAnalysisVerdict(verdictDir, 'conn-1', 'conn-2')!.analysisId).toBe('a-restart');
  });

  it('P1-2 eviction: LRU-evicted pair still resolves via durable fallback', () => {
    const svc = new MigrationService({} as any);
    const now = Date.now();
    // Seed the pair under test, then persist it (as runAnalysis would).
    seedCompletedJob(svc, { id: 'a-target', source: 'conn-1', target: 'conn-2', completedAt: now });
    saveAnalysisVerdict(verdictDir, {
      analysisId: 'a-target',
      sourceConnectionId: 'conn-1',
      targetConnectionId: 'conn-2',
      completedAt: now,
      createdAt: now - 1000,
      incompatibilities: [],
      blockingCount: 0,
      warningCount: 0,
    });

    // Flood with 20+ other pairs to force MAX_JOBS=20 LRU eviction of memory.
    for (let i = 0; i < 25; i++) {
      seedCompletedJob(svc, {
        id: `other-${i}`,
        source: `s-${i}`,
        target: `t-${i}`,
        completedAt: now + i + 1,
      });
    }
    (svc as any).evictOldJobs?.();
    // Memory may have evicted a-target, but the gate must still find it on disk.
    const found = svc.findLatestCompletedAnalysis('conn-1', 'conn-2');
    expect(found).toBeDefined();
    expect(found!.id).toBe('a-target');
  });

  it('P1-2 stale file verdict surfaces ANALYSIS_STALE (not silent pass)', async () => {
    const staleAt = Date.now() - 25 * 3600 * 1000;
    const svc = new MigrationExecutionService(
      mockRegistry() as any,
      {
        findLatestCompletedAnalysis: () => ({
          id: 'a-stale',
          status: 'completed',
          progress: 100,
          createdAt: staleAt,
          completedAt: staleAt,
          incompatibilities: [],
        }),
      } as any,
    );
    const err = await svc
      .startExecution({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' })
      .catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err.getResponse() as any).code).toBe('ANALYSIS_STALE');
  });
});
