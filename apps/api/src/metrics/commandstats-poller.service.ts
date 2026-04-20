import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '../common/services/multi-connection-poller';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { parseCommandStatsSection, CommandStatsSample } from './commandstats-parser';

interface ConnectionBaseline {
  samples: Map<string, CommandStatsSample>;
  lastCapturedAt: number;
}

export interface CommandStatsSnapshotEntry {
  command: string;
  callsTotal: number;
  usecTotal: number;
  usecPerCall: number;
  rejectedCalls: number;
  failedCalls: number;
  capturedAt: number;
}

@Injectable()
export class CommandstatsPollerService
  extends MultiConnectionPoller
  implements OnModuleInit
{
  protected readonly logger = new Logger(CommandstatsPollerService.name);

  private readonly POLL_INTERVAL_MS = 60_000; // 60 seconds
  private readonly PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private lastPruneByConnection = new Map<string, number>();
  private baselines = new Map<string, ConnectionBaseline>();

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
    this.logger.log(
      `Starting commandstats polling (interval: ${this.getIntervalMs()}ms)`,
    );
    this.start();
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.baselines.delete(connectionId);
    this.lastPruneByConnection.delete(connectionId);
  }

  getSnapshot(connectionId: string): CommandStatsSnapshotEntry[] {
    const baseline = this.baselines.get(connectionId);
    if (!baseline) return [];

    return Array.from(baseline.samples.entries()).map(([command, sample]) => ({
      command,
      callsTotal: sample.calls,
      usecTotal: sample.usec,
      usecPerCall: sample.usecPerCall,
      rejectedCalls: sample.rejectedCalls,
      failedCalls: sample.failedCalls,
      capturedAt: baseline.lastCapturedAt,
    }));
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const now = Date.now();
    let raw: Record<string, unknown>;
    try {
      raw = await ctx.client.getInfo(['commandstats']);
    } catch (error) {
      this.logger.warn(
        `commandstats unavailable on ${ctx.connectionName}: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    const section = (raw.commandstats ?? raw['Commandstats']) as
      | Record<string, string>
      | undefined;
    const current = parseCommandStatsSection(section);

    const currentByCommand = new Map(current.map((s) => [s.command, s]));

    const previous = this.baselines.get(ctx.connectionId);
    if (!previous) {
      this.baselines.set(ctx.connectionId, {
        samples: currentByCommand,
        lastCapturedAt: now,
      });
      return;
    }

    const intervalMs = now - previous.lastCapturedAt;
    const batch: Array<{
      command: string;
      callsTotal: number;
      usecTotal: number;
      usecPerCall: number;
      rejectedCalls: number;
      failedCalls: number;
      callsDelta: number;
      usecDelta: number;
      intervalMs: number;
      capturedAt: number;
    }> = [];

    let hadReset = false;
    for (const sample of current) {
      const prev = previous.samples.get(sample.command);
      if (!prev) {
        continue;
      }
      const callsDelta = sample.calls - prev.calls;
      const usecDelta = sample.usec - prev.usec;
      if (callsDelta < 0 || usecDelta < 0) {
        hadReset = true;
        break;
      }
      if (callsDelta === 0 && usecDelta === 0) continue;

      batch.push({
        command: sample.command,
        callsTotal: sample.calls,
        usecTotal: sample.usec,
        usecPerCall: sample.usecPerCall,
        rejectedCalls: sample.rejectedCalls,
        failedCalls: sample.failedCalls,
        callsDelta,
        usecDelta,
        intervalMs,
        capturedAt: now,
      });
    }

    // Update baseline regardless — reset case also needs a fresh baseline
    this.baselines.set(ctx.connectionId, {
      samples: currentByCommand,
      lastCapturedAt: now,
    });

    if (hadReset || batch.length === 0) {
      if (hadReset) {
        this.logger.log(
          `commandstats counter reset on ${ctx.connectionName}, re-baselining`,
        );
      }
      return;
    }

    await this.storage.saveCommandStatsSamples(batch, ctx.connectionId);

    const lastPrune = this.lastPruneByConnection.get(ctx.connectionId) ?? 0;
    if (now - lastPrune > this.PRUNE_INTERVAL_MS) {
      this.lastPruneByConnection.set(ctx.connectionId, now);
      await this.storage.pruneOldCommandStatsSamples(
        now - this.RETENTION_MS,
        ctx.connectionId,
      );
    }
  }
}
