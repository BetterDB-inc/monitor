import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  ConflictException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import Valkey from 'iovalkey';
import { nodeClientAuthOptions } from './execution/client-factory';
import type { MigrationExecutionRequest, MigrationExecutionResult, StartExecutionResponse, ExecutionMode, CompleteExecutionResponse } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { MigrationService } from './migration.service';
import { getBlockingIssues } from './analysis/compatibility-checker';
import type { ExecutionJob } from './execution/execution-job';
import { findRedisShakeBinary } from './execution/redisshake-runner';
import { buildScanReaderToml, buildSyncReaderToml } from './execution/toml-builder';
import { parseLogLine, classifyRedisShakeFailure, stripAnsi } from './execution/log-parser';
import {
  applyStatusPoll,
  buildLagSnapshot,
  countSourceShards,
  createLagState,
  STATUS_POLL_MS,
  STATUS_POLL_TIMEOUT_MS,
} from './execution/replication-lag';
import { fetchShakeStatus, reservePort, type PortReservation } from './execution/shake-status';
import { runCommandMigration } from './execution/command-migration-worker';
import {
  CUTOVER_DRAIN_LIMIT_MS,
  CUTOVER_KILL_GRACE_MS,
  CUTOVER_STABLE_MS,
  CUTOVER_POLL_MS,
  CUTOVER_TIMEOUT_NOTICE,
  forcedCutoverNotice,
} from './execution/cutover';
import { shouldExcludeFunctions, isRdbRestoreCompatible } from './fork-compat';
import { probeSourceFunctionsClusterAware, parseNodeAddress } from './function-presence';
import { assertLiveMigrationPair } from './live-connections';
import { sweepStaleJobFiles } from './execution/stale-job-files';

/** Set on jobs stopped by an API shutdown rather than by the user. */
export const SHUTDOWN_CANCEL_MESSAGE = 'Stopped because BetterDB shut down';

/** Returned (503) for a migration requested once shutdown has begun. */
export const SHUTDOWN_START_MESSAGE =
  'BetterDB is shutting down; start the migration again after it restarts.';

/**
 * Everything runRedisShake needs to do before it spawns the process: the
 * function-presence notice and the optional target pre-flush. Both run inside
 * runRedisShake (after the POST has already returned the job id) so the start call
 * stays responsive, the notice is guaranteed to land before the job can go terminal,
 * and a pre-flush failure is finalized by runRedisShake's own cleanup rather than
 * leaking the credential-bearing TOML.
 */
interface RedisShakePreSpawn {
  excludeFunctions: boolean;
  sourceAdapter: Parameters<typeof probeSourceFunctionsClusterAware>[0];
  sourceConfig: Parameters<typeof probeSourceFunctionsClusterAware>[1];
  clusterEnabled: boolean;
  sourceDbType: string;
  targetDbType: string;
  emptyDbBeforeSync: boolean;
  targetAdapter: ReturnType<ConnectionRegistry['get']>;
  targetConfig: NonNullable<ReturnType<ConnectionRegistry['getConfig']>>;
  targetIsCluster: boolean;
  statusPortReservation: PortReservation | null;
}

@Injectable()
export class MigrationExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MigrationExecutionService.name);
  private jobs = new Map<string, ExecutionJob>();
  private readonly MAX_JOBS = 10;
  private readonly MAX_LOG_LINES = 500;
  private readonly ANALYSIS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  // How long shutdown waits for stopped jobs to finish their own cleanup before
  // SIGKILLing RedisShake. Matches stopExecution's SIGTERM -> SIGKILL escalation
  // and stays under the CLI's 5 s force-kill and Docker's 10 s stop timeout.
  private readonly SHUTDOWN_GRACE_MS = 3_000;
  // The in-flight run of each job (runRedisShake / runCommandMode), so shutdown
  // can wait for their finally blocks to remove the credential-bearing TOML.
  private readonly runs = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly migrationService: MigrationService,
  ) {}

  /**
   * A crash, OOM kill or SIGKILL skips runRedisShake's cleanup and leaves the
   * job's TOML (source and target credentials) in the temp dir. Remove those
   * left by earlier runs whose RedisShake process is gone.
   */
  onModuleInit(): void {
    try {
      const { removed, kept } = sweepStaleJobFiles(os.tmpdir());
      if (removed.length > 0) {
        this.logger.warn(
          `Removed ${removed.length} RedisShake config file(s) left by a migration that did not shut down cleanly`,
        );
      }
      for (const { tomlPath, pid } of kept) {
        this.logger.warn(
          `Left ${tomlPath} in place: its RedisShake process (pid ${pid}) is still running. Stop it before removing the file.`,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not sweep stale migration files: ${message}`);
    }
  }

  /**
   * main.ts enables shutdown hooks, so SIGTERM lands here. Stop every pending or
   * running migration so RedisShake does not outlive the API (a redis_shake_sync
   * job would keep writing to the target with nothing left to stop it) and its
   * TOML is removed instead of left behind.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    // Not status alone: a job the user just stopped is already 'cancelled' but
    // its RedisShake can still be running (stopExecution's SIGKILL timer would
    // die with this process). Anything with an in-flight run or a live process
    // is still ours to stop and clean up.
    const active = [...this.jobs.values()].filter(
      (job) =>
        job.status === 'pending' ||
        job.status === 'running' ||
        job.status === 'completing' ||
        this.runs.has(job.id) ||
        job.process !== null,
    );
    if (active.length === 0) return;

    this.logger.warn(`Stopping ${active.length} migration(s) because BetterDB is shutting down`);
    for (const job of active) {
      if (job.status === 'pending' || job.status === 'running' || job.status === 'completing') {
        this.clearCutoverTimer(job);
        job.status = 'cancelled';
        job.terminating = 'cancel';
        job.error = job.error ?? SHUTDOWN_CANCEL_MESSAGE;
      }
      if (job.process) {
        try {
          job.process.kill('SIGTERM');
        } catch { /* process may already be dead */ }
      }
    }

    const runs = active
      .map((job) => this.runs.get(job.id))
      .filter((run): run is Promise<void> => run !== undefined);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(runs),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.SHUTDOWN_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);

    // Anything still alive ignored SIGTERM. Kill it and remove its files here,
    // since its run's finally block may never get to.
    for (const job of active) {
      job.completedAt = job.completedAt ?? Date.now();
      if (job.process) {
        try {
          job.process.kill('SIGKILL');
        } catch { /* ignore */ }
      }
      for (const path of [job.tomlPath, job.pidPath]) {
        if (path) {
          try {
            if (existsSync(path)) unlinkSync(path);
          } catch { /* ignore cleanup errors */ }
        }
      }
    }
  }

  async startExecution(req: MigrationExecutionRequest): Promise<StartExecutionResponse> {
    if (this.shuttingDown) {
      throw new ServiceUnavailableException(SHUTDOWN_START_MESSAGE);
    }
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

    assertLiveMigrationPair(this.connectionRegistry, req.sourceConnectionId, req.targetConnectionId, mode);

    this.enforceSafetyGate(req);

    if (mode === 'redis_shake') {
      const sourceDbType = sourceAdapter.getCapabilities().dbType;
      const targetDbType = targetAdapter.getCapabilities().dbType;
      if (!isRdbRestoreCompatible(sourceDbType, targetDbType)) {
        throw new BadRequestException(
          `Cross-engine redis_shake migration (${sourceDbType} → ${targetDbType}) is not supported due to RDB version incompatibility: RESTORE would fail mid-run. Use command or redis_shake_sync mode instead.`,
        );
      }
    }

    // 3. Detect if source/target is cluster
    const sourceInfo = await sourceAdapter.getInfo(['cluster']);
    const sourceClusterSection = (sourceInfo as Record<string, Record<string, string>>).cluster ?? {};
    const clusterEnabled = String(sourceClusterSection['cluster_enabled'] ?? '0') === '1';

    const targetInfo = await targetAdapter.getInfo(['cluster']);
    const targetClusterSection = (targetInfo as Record<string, Record<string, string>>).cluster ?? {};
    const targetIsCluster = String(targetClusterSection['cluster_enabled'] ?? '0') === '1';

    const expectedShards = mode === 'redis_shake_sync'
      ? await countSourceShards(sourceAdapter, clusterEnabled)
      : null;

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

    const statusPortReservation = mode === 'redis_shake_sync' ? await reservePort() : null;
    const statusPort = statusPortReservation?.port ?? null;

    // Re-check after the awaits above: shutdown may have started (and taken its
    // snapshot of jobs and runs) while the cluster probes and port reservation
    // were outstanding. From here to trackRun() there is no await on the success
    // path, so a job registered below is always visible to onModuleDestroy.
    if (this.shuttingDown) {
      await statusPortReservation?.release();
      throw new ServiceUnavailableException(SHUTDOWN_START_MESSAGE);
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
      replicationLag: mode === 'redis_shake_sync' ? createLagState() : null,
      expectedShards,
      statusPort,
      statusPoller: null,
      cutover: null,
      cutoverTimer: null,
      cutoverStableSince: null,
      cutoverKilled: false,
      terminating: null,
      process: null,
      tomlPath: null,
      pidPath: null,
    };
    // 6. Evict old jobs before inserting the new one
    try {
      this.evictOldJobs();
    } catch (err) {
      await statusPortReservation?.release();
      throw err;
    }

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

      try {
        const tomlContent = mode === 'redis_shake_sync'
          ? buildSyncReaderToml(sourceConfig, targetConfig, {
              sourceIsCluster: clusterEnabled,
              syncReaderOptions: req.syncReaderOptions ?? {},
              targetIsCluster,
              rsOptions,
              excludeFunctions,
              statusPort: statusPort ?? undefined,
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
      } catch (err) {
        await statusPortReservation?.release();
        throw err;
      }

      // The function-presence notice and the optional target pre-flush both run inside
      // runRedisShake, before it spawns the process (see RedisShakePreSpawn): the POST
      // returns the job id without waiting on source/target masters, yet the notice is
      // guaranteed to be set before the job can go terminal, and a pre-flush failure is
      // finalized by runRedisShake's cleanup instead of leaking the credential TOML.
      const preSpawn: RedisShakePreSpawn = {
        excludeFunctions,
        sourceAdapter,
        sourceConfig,
        clusterEnabled,
        sourceDbType,
        targetDbType,
        emptyDbBeforeSync: !!req.redisShakeOptions?.emptyDbBeforeSync,
        targetAdapter,
        targetConfig,
        targetIsCluster,
        statusPortReservation,
      };

      this.trackRun(id, this.runRedisShake(job, binaryPath!, preSpawn));
    } else {
      this.trackRun(id, this.runCommandMode(job, sourceConfig, targetConfig, clusterEnabled, targetIsCluster));
    }

    return { id, status: 'pending' };
  }

  /**
   * Flush every target master before a sync. RedisShake's own `empty_db_before_sync`
   * only flushes the seed node in cluster mode, leaving other masters intact, so we
   * do it ourselves. Probe clients are built leak-safe (no reconnect loop) and torn
   * down synchronously, matching the function-presence probe.
   */
  private async flushTargetBeforeSync(
    targetAdapter: ReturnType<ConnectionRegistry['get']>,
    targetConfig: NonNullable<ReturnType<ConnectionRegistry['getConfig']>>,
    targetIsCluster: boolean,
  ): Promise<void> {
    if (targetIsCluster) {
      const nodes = await targetAdapter.getClusterNodes();
      const masters = nodes.filter(n => n.flags.includes('master'));
      await Promise.all(masters.map(async (master) => {
        const { host, port } = parseNodeAddress(master.address);
        if (!host || Number.isNaN(port)) return;
        let client: Valkey | undefined;
        try {
          client = new Valkey({
            host, port,
            ...nodeClientAuthOptions(targetConfig, host),
            lazyConnect: true,
            retryStrategy: () => null,
            maxRetriesPerRequest: 1,
          });
          await client.connect();
          await client.flushall();
        } finally {
          try { client?.disconnect(); } catch { /* ignore */ }
        }
      }));
    } else {
      await targetAdapter.getClient().flushall();
    }
    this.logger.log(`Execution pre-flush: flushed target before migration`);
  }

  /**
   * Probe the source for server-side functions and, unless the source is provably
   * clean, push a durable notice that they're being excluded from the cross-engine
   * stream. Gated on `presence !== 'absent'` so a clean instance doesn't get a scary
   * message about functions it never had; 'unknown' (probe failed) still warrants it
   * since the filter is written regardless. Cluster-aware — FUNCTION LIST is
   * node-local, so a clustered source is probed per master (matching the analysis
   * warning). Runs detached from startExecution; never throws into its caller.
   */
  private async probeAndPushFunctionNotice(
    job: ExecutionJob,
    sourceAdapter: Parameters<typeof probeSourceFunctionsClusterAware>[0],
    sourceConfig: Parameters<typeof probeSourceFunctionsClusterAware>[1],
    clusterEnabled: boolean,
    sourceDbType: string,
    targetDbType: string,
  ): Promise<void> {
    try {
      const presence = await probeSourceFunctionsClusterAware(sourceAdapter, sourceConfig, clusterEnabled);
      if (presence !== 'absent') {
        const notice = `Cross-engine migration (${sourceDbType} → ${targetDbType}): server-side functions are excluded and will not be transferred to the target.`;
        this.logger.log(`Execution ${job.id}: ${notice}`);
        job.notices.push(notice);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Execution ${job.id}: function-presence probe failed: ${message}`);
    }
  }

  // ── RedisShake mode ──

  private async runRedisShake(job: ExecutionJob, binaryPath: string, preSpawn: RedisShakePreSpawn): Promise<void> {
    try {
      // Pre-spawn work, now that the POST has already returned the job id. The notice
      // is pushed before the process starts, so it can never be missed by a UI that
      // stops polling once the job is terminal (a fast scan racing a slow probe).
      //
      // These awaits open a window where the job is still 'pending' with no process, so
      // stopExecution() can only flip the status to 'cancelled' — it has nothing to
      // kill. We must therefore re-check after every await and bail before doing
      // anything destructive (flushing the target) or committing (spawning); the
      // finally block then finalizes the cancelled job. Without this, a cancel issued
      // during the probe/flush is silently dropped and RedisShake starts anyway.
      if ((job.status as string) === 'cancelled') return;

      if (preSpawn.excludeFunctions) {
        await this.probeAndPushFunctionNotice(
          job,
          preSpawn.sourceAdapter,
          preSpawn.sourceConfig,
          preSpawn.clusterEnabled,
          preSpawn.sourceDbType,
          preSpawn.targetDbType,
        );
        if ((job.status as string) === 'cancelled') return;
      }

      // Flush the target before spawning. A failure here is caught below and finalized
      // by the finally block (TOML unlinked, completedAt set) — the credential-bearing
      // TOML never lingers, and the job doesn't stay half-finished. Guarded on cancel
      // so we never wipe a target for a run the caller already stopped.
      if (preSpawn.emptyDbBeforeSync && (job.status as string) !== 'cancelled') {
        try {
          await this.flushTargetBeforeSync(preSpawn.targetAdapter, preSpawn.targetConfig, preSpawn.targetIsCluster);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Target pre-flush failed: ${message}`);
        }
        if ((job.status as string) === 'cancelled') return;
      }

      await preSpawn.statusPortReservation?.release();
      if ((job.status as string) === 'cancelled') return;

      const proc = spawn(binaryPath, [job.tomlPath!], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.process = proc;
      job.status = 'running';

      // The PID file is what lets the startup sweep (stale-job-files.ts) tell a
      // live RedisShake from a dead one. Without it the sweep would delete this
      // run's TOML after ORPHAN_TOML_MIN_AGE_MS while the process is still
      // running, so a run whose PID cannot be recorded is stopped instead. The
      // process was spawned a moment ago, so nothing has been written yet.
      const pidPath = join(os.tmpdir(), `${job.id}.pid`);
      try {
        writeFileSync(pidPath, String(proc.pid), { encoding: 'utf-8', mode: 0o600 });
        job.pidPath = pidPath;
      } catch (err: unknown) {
        try {
          proc.kill('SIGKILL');
        } catch { /* process may already be dead */ }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not record the RedisShake PID file: ${message}`, { cause: err });
      }

      this.startStatusPoller(job);

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
        proc.on('exit', (c) => {
          exitCode = c ?? 1;
          job.process = null;
        });
        proc.on('close', () => {
          stdoutHandler.flush();
          stderrHandler.flush();
          resolve(exitCode);
        });
        proc.on('error', reject);
      });

      // Status may have been set to 'cancelled' by stopExecution() while the process was running
      const statusAfterExit = job.status as string;
      this.clearCutoverTimer(job);
      if (job.terminating === 'cutover' && statusAfterExit !== 'cancelled') {
        if (code === 0 && !job.cutoverKilled) {
          this.finishCutover(job);
        } else {
          this.failCutover(job, code);
        }
      } else if (code === 0) {
        if (statusAfterExit !== 'cancelled') {
          job.status = 'completed';
          job.progress = 100;
        }
      } else if (statusAfterExit !== 'cancelled') {
        const failure = classifyRedisShakeFailure(code, job.logs);
        job.status = 'failed';
        job.error = failure.message;
        job.failureCode = failure.code;
        this.markCutoverFailed(job);
      }
    } catch (err: unknown) {
      if ((job.status as string) !== 'cancelled') {
        const message = err instanceof Error ? err.message : String(err);
        this.markCutoverFailed(job);
        job.status = 'failed';
        job.error = message;
        this.logger.error(`Execution ${job.id} error: ${message}`);
      }
    } finally {
      this.clearCutoverTimer(job);
      await preSpawn.statusPortReservation?.release();
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
      this.stopStatusPoller(job);
      job.process = null;
      job.tomlPath = null;
      job.pidPath = null;
    }
  }

  private startStatusPoller(job: ExecutionJob): void {
    const port = job.statusPort;
    const lag = job.replicationLag;
    if (port === null || lag === null) return;
    let inFlight = false;
    job.statusPoller = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void fetchShakeStatus(port, STATUS_POLL_TIMEOUT_MS).then((status) => {
        inFlight = false;
        if (job.statusPoller === null) return;
        applyStatusPoll(lag, status, Date.now());
      });
    }, STATUS_POLL_MS);
  }

  private stopStatusPoller(job: ExecutionJob): void {
    if (job.statusPoller !== null) {
      clearInterval(job.statusPoller);
      job.statusPoller = null;
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

  private trackRun(id: string, run: Promise<void>): void {
    const tracked = run
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Execution ${id} failed: ${message}`);
      })
      .finally(() => {
        this.runs.delete(id);
      });
    this.runs.set(id, tracked);
  }

  stopExecution(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    // Idempotent for terminal states
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return true;
    }

    if (job.terminating === 'cutover') {
      throw new ConflictException('The cutover is already finishing and can no longer be stopped');
    }

    this.clearCutoverTimer(job);
    job.status = 'cancelled';
    job.terminating = 'cancel';
    this.killProcess(job);
    // For command mode, the worker checks job.status === 'cancelled' between batches

    return true;
  }

  completeExecution(id: string, options: { force: boolean; timeoutSeconds: number }): CompleteExecutionResponse {
    const job = this.jobs.get(id);
    if (!job) {
      throw new NotFoundException(`Execution job '${id}' not found`);
    }
    const canStart = job.status === 'running' && job.syncStage === 'aof_replicating';
    if (job.mode !== 'redis_shake_sync' || (!canStart && job.status !== 'completing')) {
      throw new ConflictException('Cutover is available only while a sync migration is replicating');
    }
    if (job.terminating !== 'cutover') {
      const now = Date.now();
      if (options.force) {
        this.forceCutover(job, now);
      } else if (job.status === 'running') {
        this.beginCutoverWait(job, now, options.timeoutSeconds);
      }
    }
    return { status: job.status, cutover: this.copyCutover(job.cutover)! };
  }

  private beginCutoverWait(job: ExecutionJob, now: number, timeoutSeconds: number): void {
    this.clearCutoverTimer(job);
    job.status = 'completing';
    job.cutover = { requestedAt: now, deadlineAt: now + timeoutSeconds * 1000, outcome: 'waiting' };
    job.cutoverStableSince = null;
    job.cutoverKilled = false;
    this.evaluateCutover(job, now);
    if (job.terminating !== 'cutover') {
      job.cutoverTimer = setInterval(() => this.tickCutover(job), CUTOVER_POLL_MS);
    }
  }

  private tickCutover(job: ExecutionJob): void {
    if (job.status !== 'completing' || !job.cutover) {
      this.clearCutoverTimer(job);
      return;
    }
    const now = Date.now();
    this.evaluateCutover(job, now);
    if (job.terminating === 'cutover' || now < job.cutover.deadlineAt) {
      return;
    }
    this.clearCutoverTimer(job);
    job.status = 'running';
    job.cutover.outcome = 'timed_out';
    job.notices.push(CUTOVER_TIMEOUT_NOTICE);
  }

  private evaluateCutover(job: ExecutionJob, now: number): void {
    const { fullySynced } = buildLagSnapshot(job.replicationLag, now);
    if (!fullySynced) {
      job.cutoverStableSince = null;
      return;
    }
    if (job.cutoverStableSince === null) {
      job.cutoverStableSince = now;
    }
    if (now - job.cutoverStableSince >= CUTOVER_STABLE_MS) {
      this.clearCutoverTimer(job);
      job.terminating = 'cutover';
      if (job.cutover) {
        job.cutover.outcome = 'draining';
      }
      this.killForCutover(job);
    }
  }

  private forceCutover(job: ExecutionJob, now: number): void {
    this.clearCutoverTimer(job);
    const inProgress = job.status === 'completing' ? job.cutover : null;
    const { replicationLag, shards } = buildLagSnapshot(job.replicationLag, now);
    job.cutover = {
      requestedAt: inProgress?.requestedAt ?? now,
      deadlineAt: inProgress?.deadlineAt ?? now,
      outcome: 'forced',
      forcedLag: replicationLag ?? [],
    };
    job.notices.push(forcedCutoverNotice(replicationLag, shards ?? job.expectedShards));
    job.status = 'completing';
    job.terminating = 'cutover';
    job.cutoverKilled = false;
    this.killForCutover(job);
  }

  private finishCutover(job: ExecutionJob): void {
    job.status = 'completed';
    job.progress = 100;
    job.cutoverAt = Date.now();
    if (job.cutover && job.cutover.outcome !== 'forced') {
      job.cutover.outcome = 'completed';
    }
  }

  private failCutover(job: ExecutionJob, code: number): void {
    if (job.cutoverKilled) {
      job.error = `RedisShake did not finish writing to the target within ${CUTOVER_DRAIN_LIMIT_MS / 1000}s of the cutover stop and was killed. The target may be missing writes; validate it before switching your application.`;
      job.failureCode = 'UNKNOWN';
    } else {
      const failure = classifyRedisShakeFailure(code, job.logs);
      job.error = failure.message;
      job.failureCode = failure.code;
    }
    job.status = 'failed';
    this.markCutoverFailed(job);
  }

  private markCutoverFailed(job: ExecutionJob): void {
    if (job.cutover && job.cutover.outcome !== 'timed_out') {
      job.cutover.outcome = 'failed';
    }
  }

  private killForCutover(job: ExecutionJob): void {
    this.killProcess(job, CUTOVER_DRAIN_LIMIT_MS, () => {
      job.cutoverKilled = true;
    });
  }

  private clearCutoverTimer(job: ExecutionJob): void {
    if (job.cutoverTimer) {
      clearInterval(job.cutoverTimer);
      job.cutoverTimer = null;
    }
  }

  private killProcess(job: ExecutionJob, graceMs = CUTOVER_KILL_GRACE_MS, beforeKill?: () => void): void {
    if (!job.process) {
      return;
    }
    const proc = job.process;
    try {
      proc.kill('SIGTERM');
    } catch { /* process may already be dead */ }

    setTimeout(() => {
      if (job.process) {
        beforeKill?.();
        try {
          proc.kill('SIGKILL');
        } catch { /* ignore */ }
      }
    }, graceMs);
  }

  private copyCutover(cutover: ExecutionJob['cutover']): ExecutionJob['cutover'] {
    if (!cutover) {
      return null;
    }
    return { ...cutover, ...(cutover.forcedLag ? { forcedLag: cutover.forcedLag.map((entry) => ({ ...entry })) } : {}) };
  }

  getExecution(id: string): MigrationExecutionResult | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    const lag = buildLagSnapshot(job.replicationLag, Date.now());
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
      replicationLag: lag.replicationLag,
      expectedShards: lag.shards ?? job.expectedShards,
      fullySynced: lag.fullySynced && (job.status === 'running' || job.status === 'completing'),
      cutover: this.copyCutover(job.cutover),
      cutoverAt: job.cutoverAt,
    };
  }

  private evictOldJobs(): void {
    if (this.jobs.size < this.MAX_JOBS) return;

    // A cancelled job can still have its run in flight or its RedisShake alive
    // (stopExecution SIGTERMs and only SIGKILLs 3 s later). Keep it until both
    // are gone, or onModuleDestroy could no longer find, stop and clean it up.
    const terminal = Array.from(this.jobs.entries())
      .filter(([id, j]) =>
        (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') &&
        !this.runs.has(id) &&
        j.process === null,
      )
      .sort((a, b) => a[1].startedAt - b[1].startedAt);

    for (const [id] of terminal) {
      if (this.jobs.size < this.MAX_JOBS) break;
      this.jobs.delete(id);
    }

    if (this.jobs.size >= this.MAX_JOBS) {
      throw new ServiceUnavailableException(
        `Execution job limit reached (${this.MAX_JOBS}). All slots occupied by running or stopping jobs — try again later.`,
      );
    }
  }

  /** Fail-closed gate: missing/stale analysis or blocking issues reject execution unless forced with a reason. */
  private enforceSafetyGate(req: MigrationExecutionRequest): void {
    if (!this.migrationService) {
      throw new ServiceUnavailableException(
        'Safety gate unavailable: MigrationService not wired. Refusing to execute without a blocking-compatibility check.',
      );
    }
    const latest = this.migrationService.findLatestCompletedAnalysis(
      req.sourceConnectionId,
      req.targetConnectionId,
    );

    if (!latest) {
      throw new BadRequestException({
        code: 'ANALYSIS_REQUIRED',
        detail:
          'No completed migration analysis found for this source/target pair. Run POST /migration/analysis first.',
      });
    }

    const completedAt = latest.completedAt ?? latest.createdAt ?? Date.now();
    if (Date.now() - completedAt > this.ANALYSIS_TTL_MS) {
      throw new BadRequestException({
        code: 'ANALYSIS_STALE',
        analysisId: latest.id,
        detail:
          'Latest migration analysis is older than 24h. Re-run POST /migration/analysis before execution.',
      });
    }

    const blocking = getBlockingIssues(latest.incompatibilities);
    if (blocking.length === 0) return;

    const forced = req.force === true;
    const reason = sanitizeForceReason(req.forceReason);

    if (!forced) {
      throw new BadRequestException({
        code: 'BLOCKING_INCOMPATIBILITIES',
        analysisId: latest.id,
        blocking,
        detail: `Migration blocked by ${blocking.length} blocking incompatibility(ies): ${blocking.map(b => `${b.category}:${b.title}`).join('; ')}. Re-run analysis or retry with force:true + forceReason.`,
      });
    }

    if (reason.length === 0) {
      throw new BadRequestException({
        code: 'FORCE_REASON_REQUIRED',
        analysisId: latest.id,
        blocking,
        detail: 'force:true requires a non-empty forceReason justifying the bypass.',
      });
    }

    this.logger.warn(
      `Forced execution bypassing ${blocking.length} blocking issue(s) ` +
      `analysisId=${latest.id} ` +
      `categories=[${blocking.map(b => b.category).join(',')}] ` +
      `reason=${reason}`,
    );
  }
}

// Cap + strip control chars so a client-supplied reason can't forge log lines or bloat logs.
const MAX_FORCE_REASON_LOG_LENGTH = 500;

function sanitizeForceReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim()
    .slice(0, MAX_FORCE_REASON_LOG_LENGTH);
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
