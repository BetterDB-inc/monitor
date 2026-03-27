import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Valkey from 'iovalkey';
import type {
  MigrationValidationRequest,
  MigrationValidationResult,
  StartValidationResponse,
  MigrationAnalysisResult,
  DatabaseConnectionConfig,
} from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import type { ValidationJob } from './validation/validation-job';
import { compareKeyCounts } from './validation/key-count-comparator';
import { validateSample } from './validation/sample-validator';
import { compareBaseline } from './validation/baseline-comparator';
import { MigrationService } from './migration.service';

@Injectable()
export class MigrationValidationService {
  private readonly logger = new Logger(MigrationValidationService.name);
  private jobs = new Map<string, ValidationJob>();
  private readonly MAX_JOBS = 10;

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly migrationService: MigrationService,
  ) {}

  async startValidation(req: MigrationValidationRequest): Promise<StartValidationResponse> {
    // 1. Resolve both connections (throws NotFoundException if missing)
    this.connectionRegistry.get(req.sourceConnectionId);
    this.connectionRegistry.get(req.targetConnectionId);
    const sourceConfig = this.connectionRegistry.getConfig(req.sourceConnectionId);
    const targetConfig = this.connectionRegistry.getConfig(req.targetConnectionId);

    if (!sourceConfig || !targetConfig) {
      throw new NotFoundException('Connection config not found');
    }

    // 2. Validate different connections
    if (req.sourceConnectionId === req.targetConnectionId) {
      throw new BadRequestException('Source and target must be different connections');
    }

    // 3. Optionally retrieve Phase 1 analysis result
    let analysisResult: MigrationAnalysisResult | undefined;
    if (req.analysisId) {
      const job = this.migrationService.getJob(req.analysisId);
      if (job && job.status === 'completed') {
        analysisResult = job;
      }
    }

    // 4. Create job
    const id = randomUUID();
    const job: ValidationJob = {
      id,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      result: {
        sourceConnectionId: req.sourceConnectionId,
        targetConnectionId: req.targetConnectionId,
      },
      cancelled: false,
    };
    this.jobs.set(id, job);

    // 5. Evict old jobs
    this.evictOldJobs();

    // 6. Fire and forget
    const targetAdapter = this.connectionRegistry.get(req.targetConnectionId);
    this.runValidation(job, sourceConfig, targetConfig, targetAdapter, req.migrationStartedAt, analysisResult).catch(err => {
      this.logger.error(`Validation ${id} failed: ${err.message}`);
    });

    return { id, status: 'pending' };
  }

  private async runValidation(
    job: ValidationJob,
    sourceConfig: DatabaseConnectionConfig,
    targetConfig: DatabaseConnectionConfig,
    targetAdapter: import('../common/interfaces/database-port.interface').DatabasePort,
    migrationStartedAt?: number,
    analysisResult?: MigrationAnalysisResult,
  ): Promise<void> {
    let sourceClient: Valkey | null = null;
    let targetClient: Valkey | null = null;

    try {
      job.status = 'running';

      // Create temporary iovalkey clients — same pattern as command-migration-worker.ts
      sourceClient = createClient(sourceConfig, 'BetterDB-Validation-Source');
      targetClient = createClient(targetConfig, 'BetterDB-Validation-Target');

      // Step 1: Connect check (5%)
      try {
        await sourceClient.connect();
      } catch (err: unknown) {
        // Risk #2: Source may no longer be reachable
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = `Source instance is not reachable. Ensure it is still running before validating. (${message})`;
        return;
      }

      try {
        await targetClient.connect();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = `Target instance is not reachable. (${message})`;
        return;
      }

      // PING both
      try {
        await Promise.all([sourceClient.ping(), targetClient.ping()]);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = `Source instance is not reachable. Ensure it is still running before validating. (${message})`;
        return;
      }

      job.progress = 5;

      if (job.cancelled) return;

      // Step 2: Key count comparison (20%)
      const keyCount = await compareKeyCounts(sourceClient, targetClient, analysisResult);
      job.result.keyCount = keyCount;
      job.progress = 20;

      if (job.cancelled) return;

      // Step 3: Sample validation (20–70%)
      const sampleValidation = await validateSample(sourceClient, targetClient, 500);
      job.result.sampleValidation = sampleValidation;
      job.progress = 70;

      if (job.cancelled) return;

      // Step 4: Baseline comparison (80%)
      if (migrationStartedAt) {
        const baseline = await compareBaseline(
          this.storage,
          sourceConfig.id,
          targetAdapter,
          migrationStartedAt,
        );
        job.result.baseline = baseline;
      } else {
        job.result.baseline = {
          available: false,
          unavailableReason: 'Migration start time not provided — cannot determine baseline window.',
          snapshotCount: 0,
          baselineWindowMs: 0,
          metrics: [],
        };
      }
      job.progress = 80;

      if (job.cancelled) return;

      // Step 5: Compute summary (100%)
      const baselineIssues = (job.result.baseline?.metrics ?? [])
        .filter(m => m.status !== 'normal' && m.status !== 'unavailable').length;

      const issueCount =
        (sampleValidation.missing ?? 0) +
        (sampleValidation.typeMismatches ?? 0) +
        (sampleValidation.valueMismatches ?? 0) +
        baselineIssues;

      const passed = issueCount === 0 && Math.abs(keyCount.discrepancyPercent) < 1;

      job.result.issueCount = issueCount;
      job.result.passed = passed;
      job.progress = 100;
      job.status = 'completed';
    } catch (err: unknown) {
      if (!job.cancelled) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = message;
        this.logger.error(`Validation ${job.id} error: ${message}`);
      }
    } finally {
      job.completedAt = Date.now();
      // Graceful cleanup — never Promise.all, never disconnect()
      const clients = [sourceClient, targetClient].filter((c): c is Valkey => c !== null);
      await Promise.allSettled(clients.map(c => c.quit()));
    }
  }

  cancelValidation(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.status === 'completed' || job.status === 'failed') {
      return true; // Already terminal
    }

    job.cancelled = true;
    job.status = 'failed';
    job.error = 'Cancelled by user';
    job.completedAt = Date.now();
    return true;
  }

  getValidation(id: string): MigrationValidationResult | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
      ...job.result,
    };
  }

  private evictOldJobs(): void {
    if (this.jobs.size < this.MAX_JOBS) return;

    const terminal = Array.from(this.jobs.entries())
      .filter(([, j]) => j.status === 'completed' || j.status === 'failed')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    for (const [id] of terminal) {
      if (this.jobs.size < this.MAX_JOBS) break;
      this.jobs.delete(id);
    }

    if (this.jobs.size >= this.MAX_JOBS) {
      this.logger.warn(`Validation job limit reached (${this.MAX_JOBS}). Cannot evict running jobs.`);
    }
  }
}

// ── Helpers ──

function createClient(config: DatabaseConnectionConfig, name: string): Valkey {
  return new Valkey({
    host: config.host,
    port: config.port,
    username: config.username || undefined,
    password: config.password || undefined,
    tls: config.tls ? {} : undefined,
    lazyConnect: true,
    connectionName: name,
  });
}
