import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StoragePort, StoredBulkDeleteAudit } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ClusterDiscoveryService } from '@app/cluster/cluster-discovery.service';
import {
  createBulkDeleteProgress,
  normalizeBulkDeleteParams,
  runBulkDelete,
} from './bulk-delete-engine';
import { createValkeyScanTarget } from './valkey-scan-target';
import {
  BulkDeleteMode,
  BulkDeleteJobStatus,
  BulkDeleteParams,
  BulkDeleteProgress,
  BulkDeleteRequestInput,
  BulkDeleteScope,
  ScanTarget,
  SkippedNode,
} from './types';

/** In-memory record of a running/finished job (preview or execute). */
interface BulkDeleteJob {
  id: string;
  connectionId: string;
  mode: BulkDeleteMode;
  scope: BulkDeleteScope;
  params: BulkDeleteParams;
  progress: BulkDeleteProgress;
  status: BulkDeleteJobStatus;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  cancelRequested: boolean;
  host: string | null;
  port: number | null;
  /** Cluster primaries that could not be reached and were not walked. */
  skipped: SkippedNode[];
}

/** Serializable view returned to the API/UI when polling job progress. */
export interface BulkDeleteJobView {
  id: string;
  connectionId: string;
  mode: BulkDeleteMode;
  scope: BulkDeleteScope;
  status: BulkDeleteJobStatus;
  match: string;
  type: string | null;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  matched: number;
  deleted: number;
  batches: number;
  nodesTotal: number;
  nodesDone: number;
  truncated: boolean;
  cancelled: boolean;
  sampleKeys: string[];
  perNode: BulkDeleteProgress['perNode'];
  skipped: SkippedNode[];
}

/**
 * Orchestrates the SCANDEL-style bulk delete (valkey/valkey#2623): validates
 * requests, builds per-node scan targets (single node or cluster fan-out),
 * runs the pure engine as a background job, tracks live progress for polling,
 * supports cancel, and writes a durable audit row per execute run.
 *
 * Both preview (dry-run) and execute run as jobs so a large/sparse keyspace
 * can't block an HTTP request and can be cancelled.
 */
@Injectable()
export class BulkDeleteService implements OnModuleInit {
  private readonly logger = new Logger(BulkDeleteService.name);
  private readonly jobs = new Map<string, BulkDeleteJob>();

  /** Retain finished jobs so the UI can read the final state before they age out. */
  private static readonly JOB_TTL_MS = 60 * 60 * 1000;
  private static readonly MAX_JOBS = 200;

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly clusterDiscovery: ClusterDiscoveryService,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {}

  /**
   * On boot, any audit row still marked 'running' belongs to a previous process
   * that died mid-run (in-memory jobs don't survive a restart). Reconcile them
   * to 'failed' so the audit trail doesn't show phantom in-flight runs.
   */
  async onModuleInit(): Promise<void> {
    try {
      const swept = await this.storage.markInterruptedBulkDeleteRuns(
        'Interrupted by monitor restart',
        Date.now(),
      );
      if (swept > 0) {
        this.logger.warn(`Marked ${swept} interrupted bulk-delete run(s) as failed on startup`);
      }
    } catch (err) {
      this.logger.error(
        `Failed to reconcile interrupted bulk-delete runs: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Start a bounded dry-run job that reports what WOULD be deleted. */
  startPreview(
    connectionId: string,
    input: BulkDeleteRequestInput,
  ): { jobId: string; status: BulkDeleteJobStatus } {
    return this.startJob(connectionId, input, 'dry-run');
  }

  /** Start an execute job that deletes matching keys. */
  startExecution(
    connectionId: string,
    input: BulkDeleteRequestInput,
  ): { jobId: string; status: BulkDeleteJobStatus } {
    return this.startJob(connectionId, input, 'execute');
  }

  /** Job progress, scoped to the requesting connection. Null if not found/foreign. */
  getJob(jobId: string, connectionId: string): BulkDeleteJobView | null {
    const job = this.jobs.get(jobId);
    if (!job || job.connectionId !== connectionId) return null;
    return this.toView(job);
  }

  /**
   * Request cancellation of a job owned by this connection. Returns true if a
   * running job was signalled, false if it already finished, null if there is
   * no such job for this connection.
   */
  cancelJob(jobId: string, connectionId: string): boolean | null {
    const job = this.jobs.get(jobId);
    if (!job || job.connectionId !== connectionId) return null;
    if (job.status !== 'running') return false;
    job.cancelRequested = true;
    return true;
  }

  async listAudits(connectionId: string, limit?: number): Promise<StoredBulkDeleteAudit[]> {
    return this.storage.getBulkDeleteAudits({ connectionId, limit });
  }

  private startJob(
    connectionId: string,
    input: BulkDeleteRequestInput,
    mode: BulkDeleteMode,
  ): { jobId: string; status: BulkDeleteJobStatus } {
    // Validate + normalize now so a bad request surfaces as a 400, not a failed job.
    const params = normalizeBulkDeleteParams(input, mode);
    // Confirm the connection exists before we hand back a job id.
    this.connectionRegistry.get(connectionId);

    const scope = input.scope ?? 'node';
    const config = this.connectionRegistry.getConfig(connectionId);
    const job: BulkDeleteJob = {
      id: randomUUID(),
      connectionId,
      mode,
      scope,
      params,
      progress: createBulkDeleteProgress(mode, 0),
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      cancelRequested: false,
      host: config?.host ?? null,
      port: config?.port ?? null,
      skipped: [],
    };

    this.jobs.set(job.id, job);
    this.pruneJobs();
    // Only execute runs are audited; persist a "running" row so a killed
    // process still leaves a trace (reconciled by onModuleInit on next boot).
    if (mode === 'execute') void this.persistAudit(job);
    // Fire and forget; progress is polled via getJob().
    void this.runJob(job);

    return { jobId: job.id, status: 'running' };
  }

  private async runJob(job: BulkDeleteJob): Promise<void> {
    try {
      const { targets, skipped } = await this.buildTargets(job.connectionId, job.scope);
      job.skipped = skipped;
      job.progress.nodesTotal = targets.length;
      // Empty targets only happens when every cluster primary was unreachable
      // (node scope and the no-primaries fallback always yield one target). Do
      // not report success for a run that did zero work.
      if (targets.length === 0) {
        throw new Error(
          `No reachable nodes to scan (${skipped.length} primary node(s) unreachable)`,
        );
      }
      await runBulkDelete(
        targets,
        job.params,
        { isCancelled: () => job.cancelRequested },
        job.progress,
      );
      job.status = job.progress.cancelled ? 'cancelled' : 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Bulk delete job ${job.id} failed: ${job.error}`);
    } finally {
      job.completedAt = Date.now();
      if (job.mode === 'execute') await this.persistAudit(job);
      this.pruneJobs();
    }
  }

  /**
   * Build the list of nodes to walk. 'node' scope walks only the connected
   * node; 'cluster' fans out across every discovered primary (falling back to
   * the single node when discovery finds no primaries — e.g. standalone).
   * Unreachable primaries are skipped and reported rather than failing the run.
   */
  private async buildTargets(
    connectionId: string,
    scope: BulkDeleteScope,
  ): Promise<{ targets: ScanTarget[]; skipped: SkippedNode[] }> {
    const db = this.connectionRegistry.get(connectionId);

    if (scope === 'cluster') {
      const nodes = await this.clusterDiscovery.discoverNodes(connectionId);
      const primaries = nodes.filter((n) => n.role === 'master');
      if (primaries.length > 0) {
        const targets: ScanTarget[] = [];
        const skipped: SkippedNode[] = [];
        for (const primary of primaries) {
          // address is "host:port@busport" — the client port is enough as a label.
          const label = primary.address.split('@')[0];
          try {
            const client = await this.clusterDiscovery.getNodeConnection(primary.id, connectionId);
            targets.push(createValkeyScanTarget(label, client));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Skipping unreachable primary ${label}: ${message}`);
            skipped.push({ node: label, error: message });
          }
        }
        return { targets, skipped };
      }
      this.logger.warn(
        `Cluster scope requested for ${connectionId} but no primaries discovered; falling back to single node`,
      );
    }

    return { targets: [createValkeyScanTarget('primary', db.getClient())], skipped: [] };
  }

  private async persistAudit(job: BulkDeleteJob): Promise<void> {
    const record: StoredBulkDeleteAudit = {
      id: job.id,
      connectionId: job.connectionId,
      timestamp: job.startedAt,
      completedAt: job.completedAt,
      status: job.status,
      match: job.params.match,
      type: job.params.type ?? null,
      scope: job.scope,
      matched: job.progress.matched,
      deleted: job.progress.deleted,
      batches: job.progress.batches,
      nodes: job.progress.perNode.length,
      truncated: job.progress.truncated,
      skippedNodes: job.skipped.map((s) => s.node),
      error: job.error,
      sourceHost: job.host,
      sourcePort: job.port,
    };
    try {
      await this.storage.saveBulkDeleteAudit(record);
    } catch (err) {
      // Audit is best-effort; never let a storage hiccup mask the delete result.
      this.logger.error(
        `Failed to persist bulk-delete audit ${job.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Drop finished jobs past the TTL, and hard-cap the map size. */
  private pruneJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.completedAt !== null && now - job.completedAt > BulkDeleteService.JOB_TTL_MS) {
        this.jobs.delete(id);
      }
    }
    if (this.jobs.size > BulkDeleteService.MAX_JOBS) {
      const finished = [...this.jobs.values()]
        .filter((j) => j.completedAt !== null)
        .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
      for (const job of finished) {
        if (this.jobs.size <= BulkDeleteService.MAX_JOBS) break;
        this.jobs.delete(job.id);
      }
    }
  }

  private toView(job: BulkDeleteJob): BulkDeleteJobView {
    return {
      id: job.id,
      connectionId: job.connectionId,
      mode: job.mode,
      scope: job.scope,
      status: job.status,
      match: job.params.match,
      type: job.params.type ?? null,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      matched: job.progress.matched,
      deleted: job.progress.deleted,
      batches: job.progress.batches,
      nodesTotal: job.progress.nodesTotal,
      nodesDone: job.progress.nodesDone,
      truncated: job.progress.truncated,
      cancelled: job.progress.cancelled,
      sampleKeys: job.progress.sampleKeys,
      perNode: job.progress.perNode,
      skipped: job.skipped,
    };
  }
}
