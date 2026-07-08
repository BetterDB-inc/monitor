import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '../common/services/multi-connection-poller';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { parseLatencyStatsSection } from './latencystats-parser';

export interface LatencyStatsSnapshotEntry {
  command: string;
  p50Us: number;
  p99Us: number;
  p999Us: number;
  serverVersion: string;
  capturedAt: number;
}

interface ConnectionSnapshot {
  entries: LatencyStatsSnapshotEntry[];
  capturedAt: number;
}

/**
 * Polls `INFO latencystats` (Valkey/Redis >= 7.0, `latency-tracking yes`) and
 * persists per-command p50/p99/p99.9 gauges. Each sample carries the server
 * version seen in the same INFO call so upgrade detection and pre-upgrade
 * baselines can be derived purely from storage. See valkey/valkey#3527.
 */
@Injectable()
export class LatencystatsPollerService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(LatencystatsPollerService.name);

  private readonly POLL_INTERVAL_MS = 60_000; // 60 seconds
  private readonly PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private lastPruneByConnection = new Map<string, number>();
  private snapshots = new Map<string, ConnectionSnapshot>();
  private sectionAbsentLogged = new Set<string>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return this.POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting latencystats polling (interval: ${this.getIntervalMs()}ms)`);
    this.start();
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.snapshots.delete(connectionId);
    this.lastPruneByConnection.delete(connectionId);
    this.sectionAbsentLogged.delete(connectionId);
  }

  getSnapshot(connectionId: string): LatencyStatsSnapshotEntry[] {
    return this.snapshots.get(connectionId)?.entries ?? [];
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const now = Date.now();
    let raw: Record<string, unknown>;
    try {
      raw = await ctx.client.getInfo(['server', 'latencystats']);
    } catch (error) {
      this.logger.warn(
        `latencystats unavailable on ${ctx.connectionName}: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    const section = (raw.latencystats ?? raw['Latencystats']) as
      | Record<string, string>
      | undefined;
    const server = (raw.server ?? raw['Server']) as Record<string, string> | undefined;
    const serverVersion = String(server?.valkey_version ?? server?.redis_version ?? '');

    const samples = parseLatencyStatsSection(section);
    if (!section || samples.length === 0) {
      // Pre-7.0 server or latency-tracking disabled — log once per connection.
      if (!this.sectionAbsentLogged.has(ctx.connectionId)) {
        this.sectionAbsentLogged.add(ctx.connectionId);
        this.logger.debug(
          `No latencystats data on ${ctx.connectionName} (requires Valkey/Redis >= 7.0 with latency-tracking yes)`,
        );
      }
      // Drop any prior snapshot so GET /summary doesn't keep serving stale percentiles
      // once the section disappears (e.g. latency-tracking turned off after earlier polls).
      this.snapshots.set(ctx.connectionId, { entries: [], capturedAt: now });
      return;
    }
    this.sectionAbsentLogged.delete(ctx.connectionId);

    // The digests are cumulative gauges — persist absolute values, no deltas.
    const batch = samples
      .filter((s) => s.p99Us > 0)
      .map((s) => ({
        command: s.command,
        p50Us: s.p50Us,
        p99Us: s.p99Us,
        p999Us: s.p999Us,
        serverVersion,
        capturedAt: now,
      }));

    if (batch.length === 0) {
      // No valid samples to persist; reflect that immediately (no storage write to gate on).
      this.snapshots.set(ctx.connectionId, { entries: [], capturedAt: now });
      return;
    }

    // Persist first, then publish the in-memory snapshot. GET /metrics/latencystats/summary
    // serves this snapshot while history and the regression poller read storage; updating the
    // snapshot before a durable save means a failed write would leave /summary showing fresh
    // percentiles that history never received — split behaviour and delayed/missed detection.
    await this.storage.saveLatencyStatsSamples(batch, ctx.connectionId);

    this.snapshots.set(ctx.connectionId, {
      entries: batch,
      capturedAt: now,
    });

    const lastPrune = this.lastPruneByConnection.get(ctx.connectionId) ?? 0;
    if (now - lastPrune > this.PRUNE_INTERVAL_MS) {
      this.lastPruneByConnection.set(ctx.connectionId, now);
      await this.storage.pruneOldLatencyStatsSamples(now - this.RETENTION_MS, ctx.connectionId);
    }
  }
}
