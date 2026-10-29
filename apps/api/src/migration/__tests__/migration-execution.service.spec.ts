import { MigrationExecutionService } from '../migration-execution.service';
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CUTOVER_DRAIN_LIMIT_MS, CUTOVER_TIMEOUT_NOTICE } from '../execution/cutover';
import type { ShakeStatus } from '../execution/shake-status';

jest.mock('../execution/redisshake-runner', () => ({
  findRedisShakeBinary: jest.fn().mockReturnValue('/usr/local/bin/redis-shake'),
}));

jest.mock('../execution/toml-builder', () => ({
  buildScanReaderToml: jest.fn().mockReturnValue('[scan_reader]\naddress = "127.0.0.1:6379"\n'),
  buildSyncReaderToml: jest.fn().mockReturnValue('[sync_reader]\naddress = "127.0.0.1:6379"\n'),
}));

const mockReleaseStatusPort = jest.fn().mockResolvedValue(undefined);

jest.mock('../execution/shake-status', () => ({
  reservePort: jest.fn().mockImplementation(async () => ({ port: 45678, release: mockReleaseStatusPort })),
  fetchShakeStatus: jest.fn().mockResolvedValue(null),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn().mockReturnValue({
    stdout: { on: jest.fn(), setEncoding: jest.fn() },
    stderr: { on: jest.fn(), setEncoding: jest.fn() },
    on: jest.fn().mockImplementation((event: string, cb: (code: number) => void) => {
      // runRedisShake captures the code on 'exit' but resolves on 'close'
      if (event === 'exit') setTimeout(() => cb(0), 10);
      if (event === 'close') setTimeout(() => cb(0), 20);
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

// The value FUNCTION LIST resolves to on the source probe, per presence:
//   'present' — a library exists (notice must fire, for the right reason)
//   'absent'  — clean source (notice must be suppressed)
//   'throw'   — probe errors → 'unknown' (notice still fires, filter is written regardless)
type SourceFunctions = 'present' | 'absent' | 'throw';
function sourceFunctionCall(kind: SourceFunctions): jest.Mock {
  if (kind === 'throw') return jest.fn().mockRejectedValue(new Error('probe failed'));
  return jest.fn().mockResolvedValue(kind === 'present' ? [['library_name', 'mylib']] : []);
}

function createMockRegistry(overrides?: { sourceClusterEnabled?: boolean; targetClusterEnabled?: boolean; sourceDbType?: 'valkey' | 'redis'; targetDbType?: 'valkey' | 'redis'; sourceFunctions?: SourceFunctions; sourceClusterNodes?: Array<{ flags: string[]; slots: number[][] }> }) {
  const sourceCluster = overrides?.sourceClusterEnabled ?? false;
  const targetCluster = overrides?.targetClusterEnabled ?? false;
  const sourceDbType = overrides?.sourceDbType ?? 'valkey';
  const targetDbType = overrides?.targetDbType ?? 'valkey';
  const sourceFunctions = overrides?.sourceFunctions ?? 'absent';

  const mockSourceAdapter = {
    getCapabilities: jest.fn().mockReturnValue({ dbType: sourceDbType, version: '8.1.0' }),
    getInfo: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: sourceCluster ? '1' : '0' } }),
    // getClient now carries `call` so the probe exercises a real FUNCTION LIST path
    // rather than throwing TypeError and passing through the error branch by accident.
    getClient: jest.fn().mockReturnValue({ call: sourceFunctionCall(sourceFunctions), quit: jest.fn() }),
    ...(overrides?.sourceClusterNodes
      ? { getClusterNodes: jest.fn().mockResolvedValue(overrides.sourceClusterNodes) }
      : {}),
  };
  const mockTargetAdapter = {
    getCapabilities: jest.fn().mockReturnValue({ dbType: targetDbType, version: '8.1.0' }),
    getInfo: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: targetCluster ? '1' : '0' } }),
    getClient: jest.fn().mockReturnValue({ quit: jest.fn() }),
  };

  const adapters: Record<string, typeof mockSourceAdapter> = {
    'conn-1': mockSourceAdapter,
    'conn-2': mockTargetAdapter,
  };

  return {
    get: jest.fn().mockImplementation((id: string) => adapters[id] ?? mockSourceAdapter),
    getConfig: jest.fn().mockReturnValue({
      id: 'conn-1',
      name: 'Test',
      host: '127.0.0.1',
      port: 6379,
      createdAt: Date.now(),
    }),
    mockSourceAdapter,
    mockTargetAdapter,
  };
}

// Fail-closed gate: tests inject a clean analysis so they take the production path.
function createMockMigrationService(
  analysis?: Record<string, unknown> | null,
) {
  const fresh = {
    id: 'analysis-1',
    status: 'completed',
    progress: 100,
    createdAt: Date.now(),
    completedAt: Date.now(),
    sourceConnectionId: 'conn-1',
    targetConnectionId: 'conn-2',
    incompatibilities: [],
    blockingCount: 0,
    warningCount: 0,
    ...(analysis ?? {}),
  };
  return {
    findLatestCompletedAnalysis: jest
      .fn()
      .mockReturnValue(analysis === null ? undefined : fresh),
  };
}

function createExecutionService(
  registry: ReturnType<typeof createMockRegistry>,
  analysis?: Record<string, unknown> | null,
): MigrationExecutionService {
  return new MigrationExecutionService(
    registry as any,
    createMockMigrationService(analysis) as any,
  );
}

// startExecution now fires the function-presence probe detached (so the POST returns
// before it connects to the source masters), pushing the notice a beat later. Draining
// the microtask + immediate queue lets that probe settle before we assert on notices.
const flushProbe = () => new Promise((resolve) => setImmediate(resolve));

describe('MigrationExecutionService', () => {
  let service: MigrationExecutionService;
  let registry: ReturnType<typeof createMockRegistry>;

  beforeEach(() => {
    registry = createMockRegistry();
    service = createExecutionService(registry);
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

    it('should pass targetIsCluster: true when target reports cluster_enabled=1', async () => {
      const { runCommandMigration } = require('../execution/command-migration-worker');

      const clusterRegistry = createMockRegistry({ targetClusterEnabled: true });
      const clusterService = createExecutionService(clusterRegistry);

      await clusterService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'command',
      });

      // Wait a tick for the async runCommandMode to call runCommandMigration
      await new Promise(r => setTimeout(r, 20));

      expect(runCommandMigration).toHaveBeenCalledWith(
        expect.objectContaining({ targetIsCluster: true }),
      );
    });

    it('should pass targetIsCluster: false when target is standalone', async () => {
      const { runCommandMigration } = require('../execution/command-migration-worker');
      (runCommandMigration as jest.Mock).mockClear();

      await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'command',
      });

      await new Promise(r => setTimeout(r, 20));

      expect(runCommandMigration).toHaveBeenCalledWith(
        expect.objectContaining({ targetIsCluster: false }),
      );
    });

    it('should route redis_shake_sync to buildSyncReaderToml and return pending status', async () => {
      const { buildSyncReaderToml, buildScanReaderToml } = require('../execution/toml-builder');
      (buildSyncReaderToml as jest.Mock).mockClear();
      (buildScanReaderToml as jest.Mock).mockClear();

      const result = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });

      expect(result.id).toBeDefined();
      expect(result.status).toBe('pending');
      expect(buildSyncReaderToml).toHaveBeenCalledTimes(1);
      expect(buildScanReaderToml).not.toHaveBeenCalled();
    });

    it('should forward syncReaderOptions to buildSyncReaderToml', async () => {
      const { buildSyncReaderToml } = require('../execution/toml-builder');
      (buildSyncReaderToml as jest.Mock).mockClear();

      await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
        syncReaderOptions: { preferReplica: true },
      });

      expect(buildSyncReaderToml).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          syncReaderOptions: { preferReplica: true },
          // source and target are both valkey in this mock, so functions are kept
          excludeFunctions: false,
        }),
      );
    });

    it('excludes functions when source and target are different engines', async () => {
      const { buildSyncReaderToml } = require('../execution/toml-builder');
      (buildSyncReaderToml as jest.Mock).mockClear();

      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis' });
      const crossForkService = createExecutionService(crossForkRegistry);

      await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });

      // buildSyncReaderToml's options object must carry excludeFunctions: true for valkey→redis
      const call = (buildSyncReaderToml as jest.Mock).mock.calls.at(-1)!;
      expect(call[2]).toEqual(expect.objectContaining({ excludeFunctions: true }));
    });

    it('surfaces the cross-engine functions-exclusion notice when the source has functions', async () => {
      // 'present': a real library exists on the source, so the notice must fire — and
      // fire because FUNCTION LIST returned a library, not because the probe errored.
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'present' });
      const crossForkService = createExecutionService(crossForkRegistry);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });

      await flushProbe();
      const result = crossForkService.getExecution(id);
      expect(result!.notices!.some(n => /functions are excluded/i.test(n))).toBe(true);
    });

    it('sets the notice before the job goes terminal, so a fast run cannot race it away', async () => {
      // Regression: the probe runs inside runRedisShake *before* the process spawns, so
      // the notice is present by the time the job first reports 'running' and long
      // before it completes. A UI that stops polling once the job is terminal can never
      // miss it, even if the migration finishes quickly.
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'present' });
      const crossForkService = createExecutionService(crossForkRegistry);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });

      // Let the mocked process run to close (resolves at 20ms) so the job is terminal.
      await new Promise(r => setTimeout(r, 30));
      const result = crossForkService.getExecution(id);
      expect(result!.status).toBe('completed');
      expect(result!.notices!.some(n => /functions are excluded/i.test(n))).toBe(true);
    });

    it('drops the migration when cancelled during pre-spawn work', async () => {
      // Regression: the probe/pre-flush awaits leave the job 'pending' with no process,
      // so stopExecution() can only flip the status to 'cancelled'. runRedisShake must
      // notice that and bail before flushing the target or spawning RedisShake.
      const { spawn } = require('child_process');
      (spawn as jest.Mock).mockClear();

      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'present' });
      const flushall = jest.fn().mockResolvedValue('OK');
      crossForkRegistry.mockTargetAdapter.getClient = jest.fn().mockReturnValue({ flushall, quit: jest.fn() });
      const crossForkService = createExecutionService(crossForkRegistry);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
        redisShakeOptions: { emptyDbBeforeSync: true },
      });

      // Cancel while runRedisShake is still suspended in its pre-spawn awaits.
      crossForkService.stopExecution(id);
      await new Promise(r => setTimeout(r, 30));

      const result = crossForkService.getExecution(id);
      expect(result!.status).toBe('cancelled');
      expect(spawn).not.toHaveBeenCalled();
      expect(flushall).not.toHaveBeenCalled();
    });

    it('releases the status port when cancelled before spawning', async () => {
      mockReleaseStatusPort.mockClear();
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'present' });
      const crossForkService = createExecutionService(crossForkRegistry);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });
      crossForkService.stopExecution(id);
      await new Promise(r => setTimeout(r, 30));

      expect(mockReleaseStatusPort).toHaveBeenCalled();
    });

    it('releases the status port when the sync TOML cannot be built', async () => {
      mockReleaseStatusPort.mockClear();
      const { buildSyncReaderToml } = require('../execution/toml-builder');
      (buildSyncReaderToml as jest.Mock).mockImplementationOnce(() => { throw new Error('Invalid host: empty or too long'); });

      await expect(service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      })).rejects.toThrow('Invalid host');
      expect(mockReleaseStatusPort).toHaveBeenCalled();
    });

    it('holds the status port through pre-spawn work and releases it just before spawning', async () => {
      const { spawn } = require('child_process');
      (spawn as jest.Mock).mockClear();
      mockReleaseStatusPort.mockClear();
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'present' });
      const crossForkService = createExecutionService(crossForkRegistry);

      await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });
      expect(mockReleaseStatusPort).not.toHaveBeenCalled();
      await new Promise(r => setTimeout(r, 5));

      expect(spawn).toHaveBeenCalled();
      expect(mockReleaseStatusPort.mock.invocationCallOrder[0])
        .toBeLessThan((spawn as jest.Mock).mock.invocationCallOrder[0]);
    });

    it('still surfaces the notice when the source probe fails (unknown presence)', async () => {
      // 'throw' -> 'unknown': the filter is written regardless, so an indeterminate
      // probe must not silently drop the warning.
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'throw' });
      const crossForkService = createExecutionService(crossForkRegistry);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });

      await flushProbe();
      const result = crossForkService.getExecution(id);
      expect(result!.notices!.some(n => /functions are excluded/i.test(n))).toBe(true);
    });

    it('keeps the exclusion notice even after the log cap rolls over', async () => {
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'present' });
      const crossForkService = createExecutionService(crossForkRegistry);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });

      await flushProbe();
      // Simulate a long run flooding the rolling log buffer past its cap.
      const job = (crossForkService as any).jobs.get(id);
      for (let i = 0; i < 600; i++) {
        job.logs.push(`progress line ${i}`);
        if (job.logs.length > 500) job.logs.shift();
      }

      const result = crossForkService.getExecution(id);
      // The notice lives in its own field, never in the rolling (and now-overflowed) logs.
      expect(result!.notices!.some(n => /functions are excluded/i.test(n))).toBe(true);
      expect(result!.logs.some(l => /functions are excluded/i.test(l))).toBe(false);
    });

    it('omits the exclusion notice when the source has no functions', async () => {
      // 'absent': a clean instance that just saw a warning-free analysis must not then
      // get a scary "functions excluded" notice about functions it never had. This is
      // the suppression gate the previous review asked for.
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'absent' });
      const crossForkService = createExecutionService(crossForkRegistry);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });

      await flushProbe();
      const result = crossForkService.getExecution(id);
      expect(result!.notices ?? []).toHaveLength(0);
    });

    describe('RDB preflight (v11 vs v12)', () => {
      it('blocks Valkey -> Redis via redis_shake before spawn', async () => {
        const { buildScanReaderToml } = require('../execution/toml-builder');
        const { spawn } = require('child_process');
        (buildScanReaderToml as jest.Mock).mockClear();
        (spawn as jest.Mock).mockClear();

        const crossRegistry = createMockRegistry({ sourceDbType: 'valkey', targetDbType: 'redis' });
        const crossService = createExecutionService(crossRegistry);

        await expect(
          crossService.startExecution({
            sourceConnectionId: 'conn-1',
            targetConnectionId: 'conn-2',
            mode: 'redis_shake',
          }),
        ).rejects.toThrow(/use command or redis_shake_sync/i);

        expect(buildScanReaderToml).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      });

      it('blocks Redis -> Valkey via redis_shake before spawn', async () => {
        const crossRegistry = createMockRegistry({ sourceDbType: 'redis', targetDbType: 'valkey' });
        const crossService = createExecutionService(crossRegistry);

        await expect(
          crossService.startExecution({
            sourceConnectionId: 'conn-1',
            targetConnectionId: 'conn-2',
            mode: 'redis_shake',
          }),
        ).rejects.toThrow(/use command or redis_shake_sync/i);
      });

      it('blocks cross-engine when mode defaults to redis_shake', async () => {
        const crossRegistry = createMockRegistry({ sourceDbType: 'redis', targetDbType: 'valkey' });
        const crossService = createExecutionService(crossRegistry);

        await expect(
          crossService.startExecution({
            sourceConnectionId: 'conn-1',
            targetConnectionId: 'conn-2',
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('allows same-engine redis_shake (Redis -> Redis, Valkey -> Valkey)', async () => {
        for (const engine of ['redis', 'valkey'] as const) {
          const sameRegistry = createMockRegistry({ sourceDbType: engine, targetDbType: engine });
          const sameService = createExecutionService(sameRegistry);

          const result = await sameService.startExecution({
            sourceConnectionId: 'conn-1',
            targetConnectionId: 'conn-2',
            mode: 'redis_shake',
          });
          expect(result.id).toBeDefined();
        }
      });

      it('leaves redis_shake_sync and command unaffected cross-engine', async () => {
        const { runCommandMigration } = require('../execution/command-migration-worker');

        for (const mode of ['redis_shake_sync', 'command'] as const) {
          const crossRegistry = createMockRegistry({ sourceDbType: 'valkey', targetDbType: 'redis' });
          const crossService = createExecutionService(crossRegistry);

          const result = await crossService.startExecution({
            sourceConnectionId: 'conn-1',
            targetConnectionId: 'conn-2',
            mode,
          });
          expect(result.id).toBeDefined();
        }

        await new Promise(r => setTimeout(r, 20));
        expect(runCommandMigration).toHaveBeenCalled();
      });
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

    it('reports expectedShards 1 and an empty lag list for a standalone sync job', async () => {
      const { id } = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });
      expect(service.getExecution(id)).toMatchObject({ expectedShards: 1, replicationLag: [], fullySynced: false });
    });

    it('counts cluster masters into expectedShards for a sync job', async () => {
      const clusterRegistry = createMockRegistry({
        sourceClusterEnabled: true,
        sourceClusterNodes: [
          { flags: ['master'], slots: [[0, 5460]] },
          { flags: ['master'], slots: [[5461, 10922]] },
          { flags: ['slave'], slots: [] },
          { flags: ['myself', 'master'], slots: [[10923, 16383]] },
        ],
      });
      const clusterService = createExecutionService(clusterRegistry);
      const { id } = await clusterService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      });
      expect(clusterService.getExecution(id)?.expectedShards).toBe(3);
    });

    it('reports null lag fields for a redis_shake job', async () => {
      const { id } = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake',
      });
      expect(service.getExecution(id)).toMatchObject({ replicationLag: null, expectedShards: null, fullySynced: false });
    });

    describe('with a running RedisShake process', () => {
      let emitStdout: (chunk: string) => void;

      beforeEach(() => {
        const { spawn } = require('child_process');
        (spawn as jest.Mock).mockReturnValueOnce({
          stdout: {
            on: jest.fn().mockImplementation((_e: string, cb: (chunk: string) => void) => { emitStdout = cb; }),
            setEncoding: jest.fn(),
          },
          stderr: { on: jest.fn(), setEncoding: jest.fn() },
          on: jest.fn(),
          kill: jest.fn(),
          pid: 12345,
        });
      });

      async function startRunningSyncJob(): Promise<string> {
        const { id } = await service.startExecution({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-2',
          mode: 'redis_shake_sync',
        });
        for (let i = 0; i < 50 && service.getExecution(id)?.status !== 'running'; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return id;
      }

      async function poll(times: number): Promise<void> {
        for (let i = 0; i < times; i++) {
          jest.advanceTimersByTime(1000);
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
        const { fetchShakeStatus } = require('../execution/shake-status');
        (fetchShakeStatus as jest.Mock).mockResolvedValue({
          consistent: true,
          shards: [{ shard: 'src-0', inAof: true, diff: 0 }],
        });
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('passes a free status port to the sync TOML', async () => {
        await startRunningSyncJob();
        const { buildSyncReaderToml } = require('../execution/toml-builder');
        expect(buildSyncReaderToml).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ statusPort: 45678 }),
        );
      });

      it('reports Fully synced after two consistent status polls', async () => {
        const id = await startRunningSyncJob();
        const { fetchShakeStatus } = require('../execution/shake-status');
        await poll(1);
        expect(service.getExecution(id)?.fullySynced).toBe(false);
        await poll(1);
        expect(fetchShakeStatus).toHaveBeenCalledWith(45678, expect.any(Number));
        expect(service.getExecution(id)).toMatchObject({
          replicationLag: [{ shard: 'src-0', diff: 0, stale: false }],
          fullySynced: true,
        });
      });

      it('takes the shard count from the status RedisShake reports', async () => {
        const { fetchShakeStatus } = require('../execution/shake-status');
        (fetchShakeStatus as jest.Mock).mockResolvedValue({
          consistent: false,
          shards: [
            { shard: 'src-0', inAof: true, diff: 0 },
            { shard: 'src-1', inAof: true, diff: 10 },
          ],
        });
        const id = await startRunningSyncJob();
        await poll(1);
        expect(service.getExecution(id)?.expectedShards).toBe(2);
      });

      it('ignores stdout diff lines', async () => {
        const { fetchShakeStatus } = require('../execution/shake-status');
        (fetchShakeStatus as jest.Mock).mockResolvedValue(null);
        const id = await startRunningSyncJob();
        emitStdout('read_count=[1], read_ops=[0.00], write_count=[1], write_ops=[0.00], syncing aof, diff=[0]\n');
        await poll(2);
        expect(service.getExecution(id)).toMatchObject({ replicationLag: [], fullySynced: false });
      });

      it('never reports fullySynced once the job is no longer running', async () => {
        const id = await startRunningSyncJob();
        await poll(2);
        await service.stopExecution(id);
        expect(service.getExecution(id)?.fullySynced).toBe(false);
      });
    });
  });

  describe('completeExecution', () => {
    const STATS = 'read_count=[1], read_ops=[0.00], write_count=[1], write_ops=[0.00]';
    let emitStdout: (chunk: string) => void;
    let exitCb: (code: number | null, signal: string | null) => void;
    let closeCb: () => void;
    let kill: jest.Mock;

    function queueProcess(): void {
      kill = jest.fn();
      const { spawn } = require('child_process');
      (spawn as jest.Mock).mockReturnValueOnce({
        stdout: {
          on: jest.fn().mockImplementation((_e: string, cb: (chunk: string) => void) => { emitStdout = cb; }),
          setEncoding: jest.fn(),
        },
        stderr: { on: jest.fn(), setEncoding: jest.fn() },
        on: jest.fn().mockImplementation((event: string, cb: (code?: number) => void) => {
          if (event === 'exit') exitCb = cb as (code: number | null, signal: string | null) => void;
          if (event === 'close') closeCb = cb as () => void;
        }),
        kill,
        pid: 12345,
      });
    }

    let shakeStatus: ShakeStatus | null = null;

    beforeEach(() => {
      shakeStatus = null;
      const { fetchShakeStatus } = require('../execution/shake-status');
      (fetchShakeStatus as jest.Mock).mockImplementation(async () => shakeStatus);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const line = (diff: number) => {
      shakeStatus = { consistent: diff === 0, shards: [{ shard: 'src-0', inAof: true, diff }] };
    };

    async function startJob(mode: 'redis_shake_sync' | 'redis_shake' = 'redis_shake_sync'): Promise<string> {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      queueProcess();
      const { id } = await service.startExecution({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2', mode });
      for (let i = 0; i < 50 && service.getExecution(id)?.status !== 'running'; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return id;
    }

    async function startAofJob(diff = 0): Promise<string> {
      const id = await startJob();
      emitStdout(`${STATS}, syncing aof, diff=[${diff}]\n`);
      line(diff);
      await jest.advanceTimersByTimeAsync(2000);
      return id;
    }

    async function stream(diff: number, ms: number): Promise<void> {
      line(diff);
      for (let t = 0; t < ms; t += 500) {
        await jest.advanceTimersByTimeAsync(500);
      }
    }

    async function exitWith(code: number | null, signal: string | null = null): Promise<void> {
      exitCb(code, signal);
      closeCb();
      await flushProbe();
      await flushProbe();
    }

    it('throws NotFound for an unknown id', () => {
      expect(() => service.completeExecution('nope', { force: false, timeoutSeconds: 300 })).toThrow(NotFoundException);
    });

    it('throws Conflict for a redis_shake job', async () => {
      const id = await startJob('redis_shake');
      expect(() => service.completeExecution(id, { force: false, timeoutSeconds: 300 })).toThrow(ConflictException);
    });

    it('throws Conflict before the stage reaches aof_replicating', async () => {
      const id = await startJob();
      expect(() => service.completeExecution(id, { force: false, timeoutSeconds: 300 })).toThrow(ConflictException);
    });

    it('enters completing with a waiting attempt and the requested deadline', async () => {
      const id = await startAofJob(5);
      const result = service.completeExecution(id, { force: false, timeoutSeconds: 60 });
      expect(result.status).toBe('completing');
      expect(result.cutover.outcome).toBe('waiting');
      expect(result.cutover.deadlineAt - result.cutover.requestedAt).toBe(60_000);
      expect(service.getExecution(id)).toMatchObject({ status: 'completing', cutover: { outcome: 'waiting' } });
    });

    it('kills RedisShake after lag stays at zero for the stable window', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 1500);
      expect(kill).not.toHaveBeenCalled();
      await stream(0, 500);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('restarts the stable window when lag rises', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 1500);
      await stream(10, 500);
      await stream(0, 1500);
      expect(kill).not.toHaveBeenCalled();
      await stream(0, 2500);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('completes when RedisShake exits cleanly after a cutover stop', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 2000);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      await exitWith(0);
      const exec = service.getExecution(id)!;
      expect(exec).toMatchObject({ status: 'completed', progress: 100, cutover: { outcome: 'completed' } });
      expect(exec.cutoverAt).toEqual(expect.any(Number));
      expect(exec.error).toBeUndefined();
      expect(exec.failureCode).toBeUndefined();
    });

    it('fails the cutover when RedisShake crashes after the cutover stop', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 2000);
      emitStdout('panic: redis writer: OOM command not allowed\n');
      await exitWith(2);
      const exec = service.getExecution(id)!;
      expect(exec).toMatchObject({ status: 'failed', cutover: { outcome: 'failed' } });
      expect(exec.error).toEqual(expect.any(String));
      expect(exec.cutoverAt).toBeUndefined();
    });

    it('lets RedisShake drain after a cutover stop instead of killing it after 3s', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 2000);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(service.getExecution(id)!.status).toBe('completing');
    });

    it('marks the cutover draining once Fully synced holds and RedisShake is stopped', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 2000);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(service.getExecution(id)).toMatchObject({ status: 'completing', cutover: { outcome: 'draining' } });
    });

    it('completes the cutover when RedisShake exits cleanly just before the drain limit', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 2000);
      await jest.advanceTimersByTimeAsync(CUTOVER_DRAIN_LIMIT_MS - 1000);
      exitCb(0, null);
      await jest.advanceTimersByTimeAsync(2000);
      closeCb();
      await flushProbe();
      await flushProbe();
      expect(kill).not.toHaveBeenCalledWith('SIGKILL');
      expect(service.getExecution(id)).toMatchObject({ status: 'completed', cutover: { outcome: 'completed' } });
    });

    it('fails the cutover when RedisShake has to be killed after the drain limit', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 2000);
      await jest.advanceTimersByTimeAsync(CUTOVER_DRAIN_LIMIT_MS);
      expect(kill).toHaveBeenLastCalledWith('SIGKILL');
      await exitWith(null, 'SIGKILL');
      const exec = service.getExecution(id)!;
      expect(exec).toMatchObject({ status: 'failed', cutover: { outcome: 'failed' } });
      expect(exec.error).toMatch(/did not finish writing to the target/);
    });

    it('restarts the stable window while the status endpoint stops answering', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      shakeStatus = null;
      await jest.advanceTimersByTimeAsync(3_000);
      expect(kill).not.toHaveBeenCalled();
      await stream(0, 3500);
      expect(kill).not.toHaveBeenCalled();
      await stream(0, 500);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('times out back to running with the timeout notice', async () => {
      const id = await startAofJob(5);
      service.completeExecution(id, { force: false, timeoutSeconds: 10 });
      await stream(5, 10_500);
      const exec = service.getExecution(id)!;
      expect(exec).toMatchObject({ status: 'running', cutover: { outcome: 'timed_out' } });
      expect(exec.notices).toContain(CUTOVER_TIMEOUT_NOTICE);
      expect(kill).not.toHaveBeenCalled();
    });

    it('starts a fresh attempt on retry after a timeout', async () => {
      const id = await startAofJob(5);
      const first = service.completeExecution(id, { force: false, timeoutSeconds: 10 });
      await stream(5, 10_500);
      const retry = service.completeExecution(id, { force: false, timeoutSeconds: 10 });
      expect(retry.status).toBe('completing');
      expect(retry.cutover.outcome).toBe('waiting');
      expect(retry.cutover.requestedAt).toBeGreaterThan(first.cutover.requestedAt);
      expect(service.getExecution(id)!.notices).toContain(CUTOVER_TIMEOUT_NOTICE);
    });

    it('returns the current attempt on a second non-force call while completing', async () => {
      const id = await startAofJob(5);
      const first = service.completeExecution(id, { force: false, timeoutSeconds: 60 });
      await stream(5, 1000);
      const second = service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      expect(second).toEqual(first);
    });

    it('forces immediately and records the lag it accepted', async () => {
      const id = await startAofJob(4096);
      const result = service.completeExecution(id, { force: true, timeoutSeconds: 300 });
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(result.cutover).toMatchObject({
        outcome: 'forced',
        forcedLag: [{ shard: 'src-0', diff: 4096, stale: false }],
      });
      await exitWith(0);
      const exec = service.getExecution(id)!;
      expect(exec).toMatchObject({ status: 'completed', cutover: { outcome: 'forced' } });
      expect(exec.cutoverAt).toEqual(expect.any(Number));
      expect(exec.notices).toContain('Forced cutover with src-0 4 KB behind.');
    });

    it('forces from completing and clears the wait', async () => {
      const id = await startAofJob(5);
      const waiting = service.completeExecution(id, { force: false, timeoutSeconds: 10 });
      await stream(5, 1000);
      const forced = service.completeExecution(id, { force: true, timeoutSeconds: 300 });
      expect(forced.cutover).toMatchObject({ outcome: 'forced', requestedAt: waiting.cutover.requestedAt });
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      await jest.advanceTimersByTimeAsync(12_000);
      expect(service.getExecution(id)!.cutover?.outcome).toBe('forced');
      expect(service.getExecution(id)!.notices).not.toContain(CUTOVER_TIMEOUT_NOTICE);
    });

    it('cancels a cutover in progress on stop', async () => {
      const id = await startAofJob(5);
      service.completeExecution(id, { force: false, timeoutSeconds: 10 });
      service.stopExecution(id);
      expect(service.getExecution(id)!.status).toBe('cancelled');
      await jest.advanceTimersByTimeAsync(11_000);
      await exitWith(1);
      expect(service.getExecution(id)!.status).toBe('cancelled');
      expect(service.getExecution(id)!.notices).not.toContain(CUTOVER_TIMEOUT_NOTICE);
    });

    it('fails normally when RedisShake exits by itself while completing', async () => {
      const id = await startAofJob(5);
      service.completeExecution(id, { force: false, timeoutSeconds: 60 });
      await exitWith(1);
      expect(service.getExecution(id)).toMatchObject({ status: 'failed', cutover: { outcome: 'failed' } });
      await jest.advanceTimersByTimeAsync(61_000);
      expect(service.getExecution(id)!.status).toBe('failed');
    });

    it('refuses to stop a cutover that is already stopping RedisShake', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      await stream(0, 2000);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(() => service.stopExecution(id)).toThrow(ConflictException);
      await exitWith(0);
      expect(service.getExecution(id)).toMatchObject({ status: 'completed', cutover: { outcome: 'completed' } });
    });

    it('keeps fullySynced true while completing', async () => {
      const id = await startAofJob();
      service.completeExecution(id, { force: false, timeoutSeconds: 300 });
      expect(service.getExecution(id)).toMatchObject({ status: 'completing', fullySynced: true });
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

      // A cancelled job is evictable only once its run has settled and its
      // RedisShake has exited, so let the stopped runs finish first.
      const runs = (service as unknown as { runs: Map<string, Promise<void>> }).runs;
      for (let i = 0; i < 200 && runs.size > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(runs.size).toBe(0);

      // One more should trigger eviction
      const { id: newId } = await service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
      });

      expect(service.getExecution(newId)).toBeDefined();
      // Oldest should be evicted
      expect(service.getExecution(ids[0])).toBeUndefined();
    });

    it('releases the status port when every job slot is running', async () => {
      const jobs = (service as unknown as { jobs: Map<string, { status: string; startedAt: number }> }).jobs;
      for (let i = 0; i < 10; i++) jobs.set(`running-${i}`, { status: 'running', startedAt: i });
      mockReleaseStatusPort.mockClear();

      await expect(service.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake_sync',
      })).rejects.toThrow(ServiceUnavailableException);
      expect(mockReleaseStatusPort).toHaveBeenCalled();
    });
  });
});

describe('MigrationExecutionService with external connections', () => {
  const EXTERNAL_MESSAGE =
    'One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances.';

  it.each([
    ['source', 'conn-1'],
    ['target', 'conn-2'],
  ])('rejects an external %s before probing or starting a worker', async (_side, externalId) => {
    const registry = createMockRegistry();
    registry.getConfig.mockImplementation((id: string) => ({
      id,
      name: id,
      host: '127.0.0.1',
      port: 6379,
      createdAt: Date.now(),
      connectionType: id === externalId ? 'external' : 'direct',
    }));
    // Live-pair check runs before the safety gate, so a stub gate suffices here.
    const service = new MigrationExecutionService(
      registry as any,
      { findLatestCompletedAnalysis: () => undefined } as any,
    );
    const { runCommandMigration } = require('../execution/command-migration-worker');
    const { spawn } = require('child_process');
    runCommandMigration.mockClear();
    spawn.mockClear();

    for (const mode of ['command', 'redis_shake', 'redis_shake_sync'] as const) {
      const error = await service
        .startExecution({ sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2', mode })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(EXTERNAL_MESSAGE);
    }
    await flushProbe();

    expect(registry.mockSourceAdapter.getInfo).not.toHaveBeenCalled();
    expect(registry.mockTargetAdapter.getInfo).not.toHaveBeenCalled();
    expect(registry.mockSourceAdapter.getClient).not.toHaveBeenCalled();
    expect(runCommandMigration).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect((service as unknown as { jobs: Map<string, unknown> }).jobs.size).toBe(0);
  });
});

describe('MigrationExecutionService with SSH-tunneled connections', () => {
  const TUNNEL_MESSAGE =
    'One or more selected instances is reached through an SSH tunnel. Migration connects to both instances directly and cannot use the tunnel yet.';

  it.each([
    ['source', 'conn-1'],
    ['target', 'conn-2'],
  ])('rejects a tunneled %s before flushing, probing or starting a worker', async (_side, tunneledId) => {
    const registry = createMockRegistry();
    registry.getConfig.mockImplementation((id: string) => ({
      id,
      name: id,
      host: '10.0.0.5',
      port: 6379,
      createdAt: Date.now(),
      connectionType: 'direct',
      ...(id === tunneledId
        ? { sshTunnel: { enabled: true, host: 'bastion', port: 22, username: 'ops', authMethod: 'password' } }
        : {}),
    }));
    const service = new MigrationExecutionService(
      registry as any,
      { findLatestCompletedAnalysis: () => undefined } as any,
    );
    const { runCommandMigration } = require('../execution/command-migration-worker');
    const { spawn } = require('child_process');
    runCommandMigration.mockClear();
    spawn.mockClear();

    for (const mode of ['command', 'redis_shake', 'redis_shake_sync'] as const) {
      const error = await service
        .startExecution({
          sourceConnectionId: 'conn-1',
          targetConnectionId: 'conn-2',
          mode,
          redisShakeOptions: { emptyDbBeforeSync: true },
        })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(TUNNEL_MESSAGE);
    }
    await flushProbe();

    expect(registry.mockTargetAdapter.getClient).not.toHaveBeenCalled();
    expect(registry.mockSourceAdapter.getInfo).not.toHaveBeenCalled();
    expect(runCommandMigration).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect((service as unknown as { jobs: Map<string, unknown> }).jobs.size).toBe(0);
  });
});
