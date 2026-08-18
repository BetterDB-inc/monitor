import { Injectable, Logger, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import Valkey from 'iovalkey';
import type { MigrationExecutionRequest, MigrationExecutionResult, StartExecutionResponse, ExecutionMode } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type { ExecutionJob } from './execution/execution-job';
import { findRedisShakeBinary } from './execution/redisshake-runner';
import { buildScanReaderToml, buildSyncReaderToml } from './execution/toml-builder';
import { parseLogLine, classifyRedisShakeFailure, stripAnsi } from './execution/log-parser';
import { runCommandMigration } from './execution/command-migration-worker';
import { shouldExcludeFunctions } from './fork-compat';
import { probeSourceFunctionsClusterAware } from './function-presence';

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
    const targetAdapter = this.connectionRegistry.get(req.targetConnectionId);
    const targetConfig = this.connectionRegistry.getConfig(req.targetConnectionId);

    if (!sourceConfig || !targetConfig) {
      throw new NotFoundException('Connection config not found');
    }

    // 2. Validate different connections
    if (req.sourceConnectionId === req.targetConnectionId) {
      throw new BadRequestException('Source and target must be different connections');
    }

    // 3. Detect if source/target is cluster
    const sourceInfo = await sourceAdapter.getInfo(['cluster']);
    const sourceClusterSection = (sourceInfo as Record<string, Record<string, string>>).cluster ?? {};
    const clusterEnabled = String(sourceClusterSection['cluster_enabled'] ?? '0') === '1';

    const targetInfo = await targetAdapter.getInfo(['cluster']);
    const targetClusterSection = (targetInfo as Record<string, Record<string, string>>).cluster ?? {};
    const targetIsCluster = String(targetClusterSection['cluster_enabled'] ?? '0') === '1';

    // 3.5. If emptyDbBeforeSync requested, flush every target master now.
    // RedisShake's own empty_db_before_sync only flushes the seed node in cluster
    // mode, leaving other masters intact. We handle it here instead.
    if ((mode === 'redis_shake' || mode === 'redis_shake_sync') && req.redisShakeOptions?.emptyDbBeforeSync) {
      if (targetIsCluster) {
        const nodes = await targetAdapter.getClusterNodes();
        const masters = nodes.filter(n => n.flags.includes('master'));
        await Promise.all(masters.map(async (master) => {
          const addrPart = master.address?.split('@')[0] ?? '';
          const lastColon = addrPart.lastIndexOf(':');
          let host = lastColon > 0 ? addrPart.substring(0, lastColon) : '';
          const port = lastColon > 0 ? parseInt(addrPart.substring(lastColon + 1), 10) : NaN;
          if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
          if (!host || isNaN(port)) return;
          const client = new Valkey({
            host, port,
            username: targetConfig?.username || undefined,
            password: targetConfig?.password || undefined,
            tls: targetConfig?.tls ? {} : undefined,
            lazyConnect: true,
          });
          await client.connect();
          await client.flushall();
          await client.quit();
        }));
      } else {
        await targetAdapter.getClient().flushall();
      }
      this.logger.log(`Execution pre-flush: flushed target before migration`);
    }

    // 4. For redis_shake modes, locate the binary upfront
    let binaryPath: string | undefined;
    if (mode === 'redis_shake' || mode === 'redis_shake_sync') {
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
      notices: [],
      progress: null,
      syncStage: null,
      process: null,
      tomlPath: null,
      pidPath: null,
    };
    // 6. Evict old jobs before inserting the new one
    this.evictOldJobs();

    this.jobs.set(id, job);

    // 7. Fire and forget based on mode
    if (mode === 'redis_shake' || mode === 'redis_shake_sync') {
      const rsOptions = req.redisShakeOptions ?? {};

      // Server-side functions use engine-specific globals (e.g. Valkey's `server`)
      // and fail to load on a different fork. When they'd be dropped for this
      // direction (Valkey -> Redis) exclude them from the RedisShake stream so the
      // key data still migrates. Only the RedisShake modes filter, so this is
      // computed here rather than for command mode.
      const sourceDbType = sourceAdapter.getCapabilities().dbType;
      const targetDbType = targetAdapter.getCapabilities().dbType;
      const excludeFunctions = shouldExcludeFunctions(sourceDbType, targetDbType);
      if (excludeFunctions) {
        // Surface the exclusion as a durable job notice — otherwise it's invisible
        // and the user only discovers missing functions from later FCALL errors.
        // Gate it on the source actually having (or maybe having) functions, so a
        // clean instance that just saw a warning-free analysis doesn't get a scary
        // "functions excluded" message about functions it never had. The filter is
        // written regardless, so 'unknown' (probe failed) still warrants the notice.
        // Cluster-aware: FUNCTION LIST is node-local, so a clustered source is probed
        // per master, matching the analysis warning.
        const presence = await probeSourceFunctionsClusterAware(sourceAdapter, sourceConfig, clusterEnabled);
        if (presence !== 'absent') {
          const notice = `Cross-engine migration (${sourceDbType} → ${targetDbType}): server-side functions are excluded and will not be transferred to the target.`;
          this.logger.log(`Execution ${id}: ${notice}`);
          job.notices.push(notice);
        }
      }

      const tomlContent = mode === 'redis_shake_sync'
        ? buildSyncReaderToml(sourceConfig, targetConfig, {
            sourceIsCluster: clusterEnabled,
            syncReaderOptions: req.syncReaderOptions ?? {},
            targetIsCluster,
            rsOptions,
            excludeFunctions,
          })
        : buildScanReaderToml(sourceConfig, targetConfig, {
            sourceIsCluster: clusterEnabled,
            targetIsCluster,
            rsOptions,
            excludeFunctions,
          });
      const tomlPath = join(os.tmpdir(), `${id}.toml`);
      writeFileSync(tomlPath, tomlContent, { encoding: 'utf-8', mode: 0o600 });
      job.tomlPath = tomlPath;

      this.runRedisShake(job, binaryPath!).catch(err => {
        this.logger.error(`Execution ${id} failed: ${err.message}`);
      });
    } else {
      this.runCommandMode(job, sourceConfig, targetConfig, clusterEnabled, targetIsCluster).catch(err => {
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

      // Write PID file for orphan detection on server restart
      const pidPath = join(os.tmpdir(), `${job.id}.pid`);
      try {
        writeFileSync(pidPath, String(proc.pid), { encoding: 'utf-8', mode: 0o600 });
        job.pidPath = pidPath;
      } catch { /* non-fatal — orphan detection is best-effort */ }

      const processLine = (rawLine: string) => {
        // Strip ANSI first: RedisShake colourises output, and the codes otherwise
        // break the log viewer, progress parsing, and failure classification alike.
        const line = stripAnsi(rawLine);
        if (line.length === 0) {
          return;
        }
        job.logs.push(sanitizeLogLine(line));
        if (job.logs.length > this.MAX_LOG_LINES) {
          job.logs.shift();
        }
        const parsed = parseLogLine(line);
        if (parsed.keysTransferred !== null) job.keysTransferred = parsed.keysTransferred;
        if (parsed.bytesTransferred !== null) job.bytesTransferred = parsed.bytesTransferred;
        if (parsed.progress !== null) job.progress = parsed.progress;
        if (parsed.syncStage !== null && job.mode === 'redis_shake_sync') job.syncStage = parsed.syncStage;
      };

      // Decode both pipes as UTF-8 at the stream level so a multi-byte sequence
      // straddling a chunk boundary is reassembled by Node rather than turning into
      // replacement characters — the line-level carry-over below only handles
      // newline splits, not mid-character splits. With an encoding set, 'data'
      // delivers strings.
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      // Each stream gets its own carry-over buffer: a chunk boundary can split a
      // line — and thus a token like BUSYKEY — across two 'data' events, so we emit
      // only complete lines and hold the trailing partial until the next chunk or
      // the final flush at 'close'.
      const makeStreamHandler = () => {
        let buffer = '';
        const onData = (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split('\n');
          buffer = parts.pop() ?? '';
          for (const line of parts) {
            processLine(line);
          }
        };
        const flush = () => {
          if (buffer.length > 0) {
            processLine(buffer);
            buffer = '';
          }
        };
        return { onData, flush };
      };

      const stdoutHandler = makeStreamHandler();
      const stderrHandler = makeStreamHandler();
      proc.stdout.on('data', stdoutHandler.onData);
      proc.stderr.on('data', stderrHandler.onData);

      // Resolve on 'close', not 'exit'. 'exit' can fire before the stdio pipes have
      // drained, and RedisShake writes its fatal BUSYKEY line (via log.Panicf) last —
      // classifying on 'exit' would race the very log we depend on. 'exit' only
      // captures the code; 'close' flushes the buffers and resolves.
      const code = await new Promise<number>((resolve, reject) => {
        let exitCode = 1;
        proc.on('exit', (c) => { exitCode = c ?? 1; });
        proc.on('close', () => {
          stdoutHandler.flush();
          stderrHandler.flush();
          resolve(exitCode);
        });
        proc.on('error', reject);
      });

      // Status may have been set to 'cancelled' by stopExecution() while the process was running
      const statusAfterExit = job.status as string;
      if (code === 0) {
        if (statusAfterExit !== 'cancelled') {
          job.status = 'completed';
          job.progress = 100;
        }
      } else if (statusAfterExit !== 'cancelled') {
        const failure = classifyRedisShakeFailure(code, job.logs);
        job.status = 'failed';
        job.error = failure.message;
        job.failureCode = failure.code;
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
      for (const path of [job.tomlPath, job.pidPath]) {
        if (path) {
          try {
            if (existsSync(path)) unlinkSync(path);
          } catch { /* ignore cleanup errors */ }
        }
      }
      job.process = null;
      job.tomlPath = null;
      job.pidPath = null;
    }
  }

  // ── Command-based mode ──

  private async runCommandMode(
    job: ExecutionJob,
    sourceConfig: Parameters<typeof runCommandMigration>[0]['sourceConfig'],
    targetConfig: Parameters<typeof runCommandMigration>[0]['targetConfig'],
    sourceIsCluster: boolean,
    targetIsCluster: boolean,
  ): Promise<void> {
    job.status = 'running';
    try {
      await runCommandMigration({
        sourceConfig,
        targetConfig,
        sourceIsCluster,
        targetIsCluster,
        job,
        maxLogLines: this.MAX_LOG_LINES,
      });

      if ((job.status as string) !== 'cancelled') {
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
      failureCode: job.failureCode,
      keysTransferred: job.keysTransferred,
      bytesTransferred: job.bytesTransferred,
      keysSkipped: job.keysSkipped,
      totalKeys: job.totalKeys ?? undefined,
      logs: [...job.logs],
      // Durable job-level notices travel in their own field, not merged into `logs`.
      // Merging put them at index 0 of a >500-line array that the viewer then renders
      // via logs.slice(-500) — silently evicting the notice — and the autoscrolling
      // pane scrolled it out of view regardless. The web layer renders these as a
      // persistent banner above the log pane instead.
      notices: [...job.notices],
      progress: job.progress,
      syncStage: job.syncStage,
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
      throw new ServiceUnavailableException(
        `Execution job limit reached (${this.MAX_JOBS}). All slots occupied by running jobs — try again later.`,
      );
    }
  }
}

// Redact credentials from RedisShake log lines before serving to the frontend
const SENSITIVE_KEYS = /(?:password|username|auth|requirepass|masterauth|token)/i;

function sanitizeLogLine(line: string): string {
  let sanitized = line;
  // 1. Quoted sensitive fields: password = "secret" or username:"admin"
  sanitized = sanitized.replace(
    new RegExp(`(${SENSITIVE_KEYS.source})\\s*[=:]\\s*"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
    (match) => {
      const eqIdx = match.search(/[=:]/);
      return match.slice(0, eqIdx + 1) + ' "***"';
    },
  );
  // 2. Unquoted sensitive fields (skip already-redacted quoted ones)
  sanitized = sanitized.replace(
    new RegExp(`(${SENSITIVE_KEYS.source})\\s*[=:]\\s*(?!["*])\\S+`, 'gi'),
    (match) => {
      const eqIdx = match.search(/[=:]/);
      return match.slice(0, eqIdx + 1) + ' ***';
    },
  );
  // 3. URL credentials: redis://user:pass@host
  sanitized = sanitized.replace(/\/\/[^:]+:[^@]+@/g, '//***:***@');
  return sanitized;
}
