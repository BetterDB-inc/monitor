import { EventEmitter } from 'events';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  MigrationExecutionService,
  SHUTDOWN_CANCEL_MESSAGE,
  SHUTDOWN_START_MESSAGE,
} from '../migration-execution.service';

jest.mock('../execution/redisshake-runner', () => ({
  findRedisShakeBinary: jest.fn().mockReturnValue('/usr/local/bin/redis-shake'),
}));

jest.mock('../execution/toml-builder', () => ({
  buildScanReaderToml: jest.fn().mockReturnValue('[scan_reader]\n[redis_writer]\n'),
  buildSyncReaderToml: jest.fn().mockReturnValue('[sync_reader]\n[redis_writer]\n'),
}));

jest.mock('child_process', () => ({ spawn: jest.fn() }));

jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true),
}));

jest.mock('../execution/command-migration-worker', () => ({
  runCommandMigration: jest.fn(),
}));

jest.mock('../execution/stale-job-files', () => ({
  sweepStaleJobFiles: jest.fn().mockReturnValue({ removed: [], kept: [] }),
}));

const { spawn } = jest.requireMock('child_process') as { spawn: jest.Mock };
const { unlinkSync, writeFileSync } = jest.requireMock('fs') as {
  unlinkSync: jest.Mock;
  writeFileSync: jest.Mock;
};
const { runCommandMigration } = jest.requireMock('../execution/command-migration-worker') as {
  runCommandMigration: jest.Mock;
};
const { sweepStaleJobFiles } = jest.requireMock('../execution/stale-job-files') as {
  sweepStaleJobFiles: jest.Mock;
};

/** A RedisShake stand-in that runs until it is signalled. */
function fakeProcess(exitsOn: Array<'SIGTERM' | 'SIGKILL'>) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: jest.Mock };
    stderr: EventEmitter & { setEncoding: jest.Mock };
    kill: jest.Mock;
    pid: number;
  };
  proc.stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  proc.stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  proc.pid = 4242;
  proc.kill = jest.fn((signal: 'SIGTERM' | 'SIGKILL') => {
    if (exitsOn.includes(signal)) {
      setImmediate(() => {
        proc.emit('exit', null, signal);
        proc.emit('close');
      });
    }
    return true;
  });
  return proc;
}

function adapter() {
  return {
    getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
    getInfo: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: '0' } }),
    getClient: jest
      .fn()
      .mockReturnValue({ call: jest.fn().mockResolvedValue([]), quit: jest.fn() }),
  };
}

function createService(
  makeAdapter: () => ReturnType<typeof adapter> = adapter,
): MigrationExecutionService {
  const registry = {
    get: jest.fn().mockImplementation(() => makeAdapter()),
    getConfig: jest.fn().mockImplementation((id: string) => ({
      id,
      name: id,
      host: '127.0.0.1',
      port: 6379,
      createdAt: Date.now(),
    })),
  };
  const migrationService = {
    findLatestCompletedAnalysis: jest.fn().mockReturnValue({
      id: 'analysis-1',
      status: 'completed',
      createdAt: Date.now(),
      completedAt: Date.now(),
      incompatibilities: [],
    }),
  };
  type Args = ConstructorParameters<typeof MigrationExecutionService>;
  const service = new MigrationExecutionService(
    registry as unknown as Args[0],
    migrationService as unknown as Args[1],
  );
  // Keep the SIGKILL path fast; production waits SHUTDOWN_GRACE_MS (3 s).
  (service as unknown as { SHUTDOWN_GRACE_MS: number }).SHUTDOWN_GRACE_MS = 50;
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  return service;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

const request = { sourceConnectionId: 'conn-1', targetConnectionId: 'conn-2' };

describe('MigrationExecutionService shutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('SIGTERMs a running RedisShake job and removes its config and PID files', async () => {
    const proc = fakeProcess(['SIGTERM']);
    spawn.mockReturnValue(proc);
    const service = createService();
    const { id } = await service.startExecution(request);
    await waitFor(() => service.getExecution(id)?.status === 'running');

    await service.onModuleDestroy();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    const job = service.getExecution(id)!;
    expect(job.status).toBe('cancelled');
    expect(job.error).toBe(SHUTDOWN_CANCEL_MESSAGE);
    expect(job.completedAt).toBeDefined();
    const removed = unlinkSync.mock.calls.map(([path]) => String(path));
    expect(removed.some((path) => path.endsWith(`${id}.toml`))).toBe(true);
    expect(removed.some((path) => path.endsWith(`${id}.pid`))).toBe(true);
  });

  it('SIGKILLs a RedisShake process that ignores SIGTERM and still removes its files', async () => {
    const proc = fakeProcess(['SIGKILL']);
    spawn.mockReturnValue(proc);
    const service = createService();
    const { id } = await service.startExecution(request);
    await waitFor(() => service.getExecution(id)?.status === 'running');

    await service.onModuleDestroy();

    expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(service.getExecution(id)!.status).toBe('cancelled');
    const removed = unlinkSync.mock.calls.map(([path]) => String(path));
    expect(removed.some((path) => path.endsWith(`${id}.toml`))).toBe(true);
  });

  it('stops a command-mode job at its next cancellation check', async () => {
    runCommandMigration.mockImplementation(async ({ job }: { job: { status: string } }) => {
      while (job.status !== 'cancelled') {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    const service = createService();
    const { id } = await service.startExecution({ ...request, mode: 'command' });
    await waitFor(() => service.getExecution(id)?.status === 'running');

    await service.onModuleDestroy();

    expect(service.getExecution(id)!.status).toBe('cancelled');
    expect(service['runs'].size).toBe(0);
  });

  it('leaves finished jobs untouched and returns at once when nothing is running', async () => {
    runCommandMigration.mockResolvedValue(undefined);
    const service = createService();
    const { id } = await service.startExecution({ ...request, mode: 'command' });
    await waitFor(() => service.getExecution(id)?.status === 'completed');

    await service.onModuleDestroy();

    expect(service.getExecution(id)!.status).toBe('completed');
    expect(service.getExecution(id)!.error).toBeUndefined();
  });

  it('also stops a job the user already cancelled whose RedisShake is still running', async () => {
    const proc = fakeProcess(['SIGKILL']);
    spawn.mockReturnValue(proc);
    const service = createService();
    const { id } = await service.startExecution(request);
    await waitFor(() => service.getExecution(id)?.status === 'running');
    service.stopExecution(id); // SIGTERM, which this process ignores

    await service.onModuleDestroy();

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    const job = service.getExecution(id)!;
    expect(job.status).toBe('cancelled');
    // A user stop is not relabelled as a shutdown stop.
    expect(job.error).toBeUndefined();
    const removed = unlinkSync.mock.calls.map(([path]) => String(path));
    expect(removed.some((path) => path.endsWith(`${id}.toml`))).toBe(true);
  });

  it('rejects a start whose probes were still running when shutdown began', async () => {
    // Every INFO probe waits on one gate, so startExecution is parked mid-way.
    let releaseProbes: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });
    const slowAdapter = () => {
      const a = adapter();
      a.getInfo = jest.fn(async () => {
        await gate;
        return { cluster: { cluster_enabled: '0' } };
      });
      return a;
    };
    const service = createService(slowAdapter);
    const start = service.startExecution(request);
    await service.onModuleDestroy();
    releaseProbes();

    await expect(start).rejects.toThrow(SHUTDOWN_START_MESSAGE);
    expect(spawn).not.toHaveBeenCalled();
    expect(service['jobs'].size).toBe(0);
  });

  it('stops RedisShake and fails the job when its PID file cannot be written', async () => {
    const proc = fakeProcess(['SIGKILL']);
    spawn.mockReturnValue(proc);
    writeFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('.pid')) throw new Error('ENOSPC');
    });
    const service = createService();
    const { id } = await service.startExecution(request);

    await waitFor(() => service.getExecution(id)?.status === 'failed');

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(service.getExecution(id)!.error).toContain('Could not record the RedisShake PID file');
    const removed = unlinkSync.mock.calls.map(([path]) => String(path));
    expect(removed.some((path) => path.endsWith(`${id}.toml`))).toBe(true);
    writeFileSync.mockReset();
  });

  it('refuses to start a migration once shutdown has begun', async () => {
    const service = createService();
    await service.onModuleDestroy();

    await expect(service.startExecution(request)).rejects.toThrow(ServiceUnavailableException);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('MigrationExecutionService startup sweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sweeps the temp dir for config files left by an unclean shutdown', () => {
    sweepStaleJobFiles.mockReturnValue({
      removed: ['/tmp/a.toml'],
      kept: [{ tomlPath: '/tmp/b.toml', pid: 99 }],
    });
    const service = createService();

    service.onModuleInit();

    expect(sweepStaleJobFiles).toHaveBeenCalledTimes(1);
    const warnings = (service['logger'].warn as jest.Mock).mock.calls.map(([msg]) => String(msg));
    expect(warnings.some((msg) => msg.includes('Removed 1 RedisShake config file'))).toBe(true);
    expect(warnings.some((msg) => msg.includes('/tmp/b.toml') && msg.includes('pid 99'))).toBe(
      true,
    );
  });

  it('never fails startup when the sweep throws', () => {
    sweepStaleJobFiles.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const service = createService();

    expect(() => service.onModuleInit()).not.toThrow();
  });
});
