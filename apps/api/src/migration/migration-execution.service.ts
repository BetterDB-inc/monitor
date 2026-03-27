import { Injectable, Logger, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { MigrationExecutionRequest, MigrationExecutionResult, StartExecutionResponse, ExecutionMode } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type { ExecutionJob } from './execution/execution-job';
import { findRedisShakeBinary } from './execution/redisshake-runner';
import { buildScanReaderToml } from './execution/toml-builder';
import { parseLogLine } from './execution/log-parser';
import { runCommandMigration } from './execution/command-migration-worker';

@Injectable()
export class MigrationExecutionService {
  private readonly logger = new Logger(MigrationExecutionService.name);
  private jobs = new Map<string, ExecutionJob>();
  private readonly MAX_JOBS = 10;
  private readonly MAX_LOG_LINES = 500;

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  async startExecution(req: MigrationExecutionRequest): Promise<StartExecutionResponse> {
    const mode: ExecutionMode = req.mode ?? 'redis_shake';

    // 1. Resolve both connections (throws NotFoundException if missing)
    const sourceAdapter = this.connectionRegistry.get(req.sourceConnectionId);
    const sourceConfig = this.connectionRegistry.getConfig(req.sourceConnectionId);
    this.connectionRegistry.get(req.targetConnectionId);
    const targetConfig = this.connectionRegistry.getConfig(req.targetConnectionId);

    if (!sourceConfig || !targetConfig) {
      throw new NotFoundException('Connection config not found');
    }

    // 2. Validate different connections
    if (req.sourceConnectionId === req.targetConnectionId) {
      throw new BadRequestException('Source and target must be different connections');
    }

    // 3. Detect if source is cluster
    const info = await sourceAdapter.getInfo(['cluster']);
    const clusterEnabled = String((info as Record<string, unknown>)['cluster_enabled'] ?? '0') === '1';

    // 4. For redis_shake mode, locate the binary upfront
    let binaryPath: string | undefined;
    if (mode === 'redis_shake') {
      try {
        binaryPath = findRedisShakeBinary();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ServiceUnavailableException(message);
      }
    }

    // 5. Create the job
    const id = randomUUID();
    const job: ExecutionJob = {
      id,
      mode,
      status: 'pending',
      startedAt: Date.now(),
      keysTransferred: 0,
      bytesTransferred: 0,
      keysSkipped: 0,
      totalKeys: 0,
      logs: [],
      progress: null,
      process: null,
      tomlPath: null,
    };
    this.jobs.set(id, job);

    // 6. Evict old jobs
    this.evictOldJobs();

    // 7. Fire and forget based on mode
    if (mode === 'redis_shake') {
      const tomlContent = buildScanReaderToml(sourceConfig, targetConfig, clusterEnabled);
      const tomlPath = join(os.tmpdir(), `${id}.toml`);
      writeFileSync(tomlPath, tomlContent, { encoding: 'utf-8', mode: 0o600 });
      job.tomlPath = tomlPath;

      this.runRedisShake(job, binaryPath!).catch(err => {
        this.logger.error(`Execution ${id} failed: ${err.message}`);
      });
    } else {
      this.runCommandMode(job, sourceConfig, targetConfig, clusterEnabled).catch(err => {
        this.logger.error(`Execution ${id} failed: ${err.message}`);
      });
    }

    return { id, status: 'pending' };
  }

  // ── RedisShake mode ──

  private async runRedisShake(job: ExecutionJob, binaryPath: string): Promise<void> {
    try {
      const proc = spawn(binaryPath, [job.tomlPath!], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.process = proc;
      job.status = 'running';

      const handleData = (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (!line) continue;
          job.logs.push(line);
          if (job.logs.length > this.MAX_LOG_LINES) {
            job.logs.shift();
          }
          const parsed = parseLogLine(line);
          if (parsed.keysTransferred !== null) job.keysTransferred = parsed.keysTransferred;
          if (parsed.bytesTransferred !== null) job.bytesTransferred = parsed.bytesTransferred;
          if (parsed.progress !== null) job.progress = parsed.progress;
        }
      };

      proc.stdout.on('data', handleData);
      proc.stderr.on('data', handleData);

      const code = await new Promise<number>((resolve, reject) => {
        proc.on('exit', (exitCode) => resolve(exitCode ?? 1));
        proc.on('error', reject);
      });

      const currentStatus = job.status as string;
      if (code === 0) {
        job.status = 'completed';
        job.progress = 100;
      } else if (currentStatus !== 'cancelled') {
        job.status = 'failed';
        job.error = `RedisShake exited with code ${code}`;
      }
    } catch (err: unknown) {
      if ((job.status as string) !== 'cancelled') {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = message;
        this.logger.error(`Execution ${job.id} error: ${message}`);
      }
    } finally {
      if (!job.completedAt) {
        job.completedAt = Date.now();
      }
      if (job.tomlPath) {
        try {
          if (existsSync(job.tomlPath)) {
            unlinkSync(job.tomlPath);
          }
        } catch { /* ignore cleanup errors */ }
      }
      job.process = null;
      job.tomlPath = null;
    }
  }

  // ── Command-based mode ──

  private async runCommandMode(
    job: ExecutionJob,
    sourceConfig: Parameters<typeof runCommandMigration>[0]['sourceConfig'],
    targetConfig: Parameters<typeof runCommandMigration>[0]['targetConfig'],
    sourceIsCluster: boolean,
  ): Promise<void> {
    job.status = 'running';
    try {
      await runCommandMigration({
        sourceConfig,
        targetConfig,
        sourceIsCluster,
        job,
        maxLogLines: this.MAX_LOG_LINES,
      });

      const currentStatus = job.status as string;
      if (currentStatus !== 'cancelled') {
        job.status = 'completed';
      }
    } catch (err: unknown) {
      if ((job.status as string) !== 'cancelled') {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = message;
        this.logger.error(`Execution ${job.id} error: ${message}`);
      }
    } finally {
      if (!job.completedAt) {
        job.completedAt = Date.now();
      }
    }
  }

  // ── Shared methods ──

  stopExecution(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    // Idempotent for terminal states
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return true;
    }

    job.status = 'cancelled';

    // For redis_shake mode, kill the subprocess
    if (job.process) {
      const proc = job.process;
      try {
        proc.kill('SIGTERM');
      } catch { /* process may already be dead */ }

      setTimeout(() => {
        if (job.process) {
          try {
            proc.kill('SIGKILL');
          } catch { /* ignore */ }
        }
      }, 3000);
    }
    // For command mode, the worker checks job.status === 'cancelled' between batches

    return true;
  }

  getExecution(id: string): MigrationExecutionResult | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    return {
      id: job.id,
      status: job.status,
      mode: job.mode,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      keysTransferred: job.keysTransferred,
      bytesTransferred: job.bytesTransferred,
      keysSkipped: job.keysSkipped,
      totalKeys: job.totalKeys || undefined,
      logs: job.logs,
      progress: job.progress,
    };
  }

  private evictOldJobs(): void {
    if (this.jobs.size < this.MAX_JOBS) return;

    const terminal = Array.from(this.jobs.entries())
      .filter(([, j]) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')
      .sort((a, b) => a[1].startedAt - b[1].startedAt);

    for (const [id] of terminal) {
      if (this.jobs.size < this.MAX_JOBS) break;
      this.jobs.delete(id);
    }

    if (this.jobs.size >= this.MAX_JOBS) {
      this.logger.warn(`Execution job limit reached (${this.MAX_JOBS}). Cannot evict running jobs.`);
    }
  }
}
