import { MigrationExecutionService } from '../migration-execution.service';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

jest.mock('../execution/redisshake-runner', () => ({
  findRedisShakeBinary: jest.fn().mockReturnValue('/usr/local/bin/redis-shake'),
}));

jest.mock('../execution/toml-builder', () => ({
  buildScanReaderToml: jest.fn().mockReturnValue('[scan_reader]\naddress = "127.0.0.1:6379"\n'),
  buildSyncReaderToml: jest.fn().mockReturnValue('[sync_reader]\naddress = "127.0.0.1:6379"\n'),
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

function createMockRegistry(overrides?: { sourceClusterEnabled?: boolean; targetClusterEnabled?: boolean; targetDbType?: 'valkey' | 'redis'; sourceFunctions?: SourceFunctions }) {
  const sourceCluster = overrides?.sourceClusterEnabled ?? false;
  const targetCluster = overrides?.targetClusterEnabled ?? false;
  const targetDbType = overrides?.targetDbType ?? 'valkey';
  const sourceFunctions = overrides?.sourceFunctions ?? 'absent';

  const mockSourceAdapter = {
    getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
    getInfo: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: sourceCluster ? '1' : '0' } }),
    // getClient now carries `call` so the probe exercises a real FUNCTION LIST path
    // rather than throwing TypeError and passing through the error branch by accident.
    getClient: jest.fn().mockReturnValue({ call: sourceFunctionCall(sourceFunctions), quit: jest.fn() }),
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

// startExecution now fires the function-presence probe detached (so the POST returns
// before it connects to the source masters), pushing the notice a beat later. Draining
// the microtask + immediate queue lets that probe settle before we assert on notices.
const flushProbe = () => new Promise((resolve) => setImmediate(resolve));

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

    it('should pass targetIsCluster: true when target reports cluster_enabled=1', async () => {
      const { runCommandMigration } = require('../execution/command-migration-worker');

      const clusterRegistry = createMockRegistry({ targetClusterEnabled: true });
      const clusterService = new MigrationExecutionService(clusterRegistry as any);

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
      const { buildScanReaderToml } = require('../execution/toml-builder');
      (buildScanReaderToml as jest.Mock).mockClear();

      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis' });
      const crossForkService = new MigrationExecutionService(crossForkRegistry as any);

      await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake',
      });

      // buildScanReaderToml's options object must carry excludeFunctions: true for valkey→redis
      const call = (buildScanReaderToml as jest.Mock).mock.calls.at(-1)!;
      expect(call[2]).toEqual(expect.objectContaining({ excludeFunctions: true }));
    });

    it('surfaces the cross-engine functions-exclusion notice when the source has functions', async () => {
      // 'present': a real library exists on the source, so the notice must fire — and
      // fire because FUNCTION LIST returned a library, not because the probe errored.
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'present' });
      const crossForkService = new MigrationExecutionService(crossForkRegistry as any);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake',
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
      const crossForkService = new MigrationExecutionService(crossForkRegistry as any);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake',
      });

      // Let the mocked process run to close (resolves at 20ms) so the job is terminal.
      await new Promise(r => setTimeout(r, 30));
      const result = crossForkService.getExecution(id);
      expect(result!.status).toBe('completed');
      expect(result!.notices!.some(n => /functions are excluded/i.test(n))).toBe(true);
    });

    it('still surfaces the notice when the source probe fails (unknown presence)', async () => {
      // 'throw' -> 'unknown': the filter is written regardless, so an indeterminate
      // probe must not silently drop the warning.
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'throw' });
      const crossForkService = new MigrationExecutionService(crossForkRegistry as any);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake',
      });

      await flushProbe();
      const result = crossForkService.getExecution(id);
      expect(result!.notices!.some(n => /functions are excluded/i.test(n))).toBe(true);
    });

    it('keeps the exclusion notice even after the log cap rolls over', async () => {
      const crossForkRegistry = createMockRegistry({ targetDbType: 'redis', sourceFunctions: 'present' });
      const crossForkService = new MigrationExecutionService(crossForkRegistry as any);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake',
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
      const crossForkService = new MigrationExecutionService(crossForkRegistry as any);

      const { id } = await crossForkService.startExecution({
        sourceConnectionId: 'conn-1',
        targetConnectionId: 'conn-2',
        mode: 'redis_shake',
      });

      await flushProbe();
      const result = crossForkService.getExecution(id);
      expect(result!.notices ?? []).toHaveLength(0);
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
