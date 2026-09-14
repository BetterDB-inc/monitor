import { Injectable, Logger } from '@nestjs/common';
import {
  FleetInstanceSummary,
  FleetOverallStatus,
  FleetSummaryResponse,
} from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { HealthService } from '../health/health.service';
import { MetricsService } from '../metrics/metrics.service';
import type { InfoResponse } from '../common/types/metrics.types';

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

  private cached: { expiresAt: number; payload: FleetSummaryResponse } | null = null;
  private readonly lastSeenUp = new Map<string, number>();

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly healthService: HealthService,
    private readonly metricsService: MetricsService,
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

    const settled = await Promise.allSettled(
      listed.map((conn) => {
        const gate = { cancelled: false };
        const result = this.withTimeout(
          this.collectOne(conn.id, conn.name, conn.host, conn.port, () => gate.cancelled),
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
      };
    });

    const upCount = instances.filter((i) => i.status === 'up').length;
    const overallStatus: FleetOverallStatus =
      upCount === instances.length
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
  ): Promise<FleetInstanceSummary> {
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
      return this.emptySummary(connectionId, name, host, port, 'unknown', error);
    }

    const health = healthResult.value;
    if (health.status !== 'connected') {
      const error = health.error ?? 'Not connected to database';
      return this.emptySummary(
        connectionId,
        name,
        host,
        port,
        health.status === 'waiting' ? 'unknown' : 'down',
        error,
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
    };
  }

  private emptySummary(
    connectionId: string,
    name: string,
    host: string,
    port: number,
    status: 'down' | 'unknown',
    error: string,
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
