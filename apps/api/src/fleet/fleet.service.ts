import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  FleetCveSummary,
  FleetInstanceSummary,
  FleetOverallStatus,
  FleetSummaryResponse,
} from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { HealthService } from '../health/health.service';
import { MetricsService } from '../metrics/metrics.service';
import type { InfoResponse } from '../common/types/metrics.types';
import type { StoragePort } from '../common/interfaces/storage-port.interface';

/**
 * Fleet-wide rollup for the multi-instance "are we green?" view.
 *
 * Reuses ConnectionRegistry.list() + HealthService.getHealth() +
 * MetricsService.getInfoParsed() — no new Redis commands, no rewrites.
 * One slow node must never block the fleet: per-instance timeout +
 * Promise.allSettled at both fan-out levels. Result cached in-memory.
 */
@Injectable()
export class FleetService {
  private readonly logger = new Logger(FleetService.name);
  private static readonly CACHE_TTL_MS = 15_000;
  private static readonly PER_INSTANCE_TIMEOUT_MS = 5_000;
  private static readonly CVE_TIMEOUT_MS = 1_000;

  private cached: { expiresAt: number; payload: FleetSummaryResponse } | null = null;
  private readonly lastSeenUp = new Map<string, number>();

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly healthService: HealthService,
    private readonly metricsService: MetricsService,
    @Optional() @Inject('STORAGE_CLIENT') private readonly storage?: StoragePort,
  ) {}

  async getSummary(): Promise<FleetSummaryResponse> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.payload;
    }
    const payload = await this.collect();
    this.cached = { expiresAt: Date.now() + FleetService.CACHE_TTL_MS, payload };
    return payload;
  }

  /** Test hook: bypass the cache. */
  async collectUncached(): Promise<FleetSummaryResponse> {
    return this.collect();
  }

  private async collect(): Promise<FleetSummaryResponse> {
    const listed = this.connectionRegistry.list();

    const listedIds = new Set(listed.map((conn) => conn.id));
    for (const id of this.lastSeenUp.keys()) {
      if (!listedIds.has(id)) {
        this.lastSeenUp.delete(id);
      }
    }

    if (listed.length === 0) {
      return { overallStatus: 'waiting', instances: [], timestamp: Date.now() };
    }

    const waiting = new Set<string>();
    const settled = await Promise.allSettled(
      listed.map((conn) => {
        const gate = { cancelled: false };
        const result = this.withTimeout(
          this.collectOne(conn.id, conn.name, conn.host, conn.port, () => gate.cancelled, waiting),
          FleetService.PER_INSTANCE_TIMEOUT_MS,
          `Timed out collecting fleet stats for ${conn.name}`,
        );
        result.catch(() => {
          gate.cancelled = true;
        });
        return result;
      }),
    );

    const instances: FleetInstanceSummary[] = settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const conn = listed[index];
      return {
        connectionId: conn.id,
        name: conn.name,
        host: conn.host,
        port: conn.port,
        status: 'unknown' as const,
        uptimeSec: null,
        memoryUsedBytes: null,
        memoryMaxBytes: null,
        memPct: null,
        opsPerSec: null,
        connectedClients: null,
        replicationRole: null,
        lastSeen: this.lastSeenUp.get(conn.id) ?? null,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        cve: null,
      };
    });

    const counted = instances.filter(
      (instance, index) => !(settled[index].status === 'fulfilled' && waiting.has(instance.connectionId)),
    );
    const upCount = counted.filter((i) => i.status === 'up').length;
    const overallStatus: FleetOverallStatus =
      counted.length === 0
        ? 'waiting'
        : upCount === counted.length
          ? 'healthy'
          : upCount > 0
            ? 'degraded'
            : 'unhealthy';

    return { overallStatus, instances, timestamp: Date.now() };
  }

  private async collectOne(
    connectionId: string,
    name: string,
    host: string,
    port: number,
    isCancelled: () => boolean = () => false,
    waiting: Set<string> = new Set(),
  ): Promise<FleetInstanceSummary> {
    const cvePromise = this.getCveSummaryWithTimeout(connectionId);
    const [healthResult, infoResult] = await Promise.allSettled([
      this.healthService.getHealth(connectionId),
      this.metricsService.getInfoParsed(undefined, connectionId),
    ]);

    if (healthResult.status === 'rejected') {
      const error =
        healthResult.reason instanceof Error
          ? healthResult.reason.message
          : String(healthResult.reason);
      this.logger.debug(`Fleet health probe failed for ${connectionId}: ${error}`);
      return this.emptySummary(
        connectionId,
        name,
        host,
        port,
        'unknown',
        error,
        await cvePromise,
      );
    }

    const health = healthResult.value;
    if (health.status === 'waiting') {
      waiting.add(connectionId);
    }
    if (health.status !== 'connected') {
      const error = health.error ?? 'Not connected to database';
      return this.emptySummary(
        connectionId,
        name,
        host,
        port,
        health.status === 'waiting' ? 'unknown' : 'down',
        error,
        await cvePromise,
      );
    }

    const now = Date.now();
    if (!isCancelled()) {
      this.lastSeenUp.set(connectionId, now);
    }

    const info: InfoResponse | null =
      infoResult.status === 'fulfilled' ? infoResult.value : null;
    if (infoResult.status === 'rejected') {
      const reason =
        infoResult.reason instanceof Error
          ? infoResult.reason.message
          : String(infoResult.reason);
      this.logger.debug(`Fleet INFO probe failed for ${connectionId}: ${reason}`);
    }

    const memoryUsedBytes = toNumberOrNull(info?.memory?.used_memory);
    const memoryMaxBytes = toNumberOrNull(info?.memory?.maxmemory);
    const memPct =
      memoryUsedBytes !== null && memoryMaxBytes !== null && memoryMaxBytes > 0
        ? (memoryUsedBytes / memoryMaxBytes) * 100
        : null;

    const cve = await cvePromise;

    return {
      connectionId,
      name,
      host,
      port,
      status: 'up',
      uptimeSec: toNumberOrNull(info?.server?.uptime_in_seconds),
      memoryUsedBytes,
      memoryMaxBytes,
      memPct,
      opsPerSec: toNumberOrNull(info?.stats?.instantaneous_ops_per_sec),
      connectedClients: toNumberOrNull(info?.clients?.connected_clients),
      replicationRole: info?.replication?.role ?? null,
      lastSeen: now,
      cve,
    };
  }

  private getCveSummaryWithTimeout(connectionId: string): Promise<FleetCveSummary | null> {
    return this.withTimeout(
      this.getCveSummary(connectionId),
      FleetService.CVE_TIMEOUT_MS,
      `Timed out reading CVE summary for ${connectionId}`,
    ).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Fleet CVE rollup degraded for ${connectionId}: ${reason}`);
      return null;
    });
  }

  private async getCveSummary(connectionId: string): Promise<FleetCveSummary | null> {
    if (!this.storage) {
      return null;
    }
    try {
      const scan = await this.storage.getCveScanResult(connectionId);
      if (!scan) {
        return null;
      }
      let critical = 0;
      let kev = 0;
      for (const node of scan.nodes) {
        critical += node.severityCounts.critical;
        for (const finding of node.findings) {
          if (finding.advisory.knownExploited === true) {
            kev += 1;
          }
        }
      }
      return {
        critical,
        kev,
        fingerprint: scan.fingerprint,
        stale: scan.partial || (scan.missingSources?.length ?? 0) > 0,
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Fleet CVE rollup failed for ${connectionId}: ${reason}`);
      return null;
    }
  }

  private emptySummary(
    connectionId: string,
    name: string,
    host: string,
    port: number,
    status: 'down' | 'unknown',
    error: string,
    cve: FleetCveSummary | null = null,
  ): FleetInstanceSummary {
    return {
      connectionId,
      name,
      host,
      port,
      status,
      uptimeSec: null,
      memoryUsedBytes: null,
      memoryMaxBytes: null,
      memPct: null,
      opsPerSec: null,
      connectedClients: null,
      replicationRole: null,
      lastSeen: this.lastSeenUp.get(connectionId) ?? null,
      error,
      cve,
    };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
