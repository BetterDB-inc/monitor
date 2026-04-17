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

@Injectable()
export class CommandstatsPollerService
  extends MultiConnectionPoller
  implements OnModuleInit
{
  protected readonly logger = new Logger(CommandstatsPollerService.name);

  private readonly POLL_INTERVAL_MS = 15_000;
  private readonly PRUNE_INTERVAL_MS = 60 * 60 * 1000;
  private readonly RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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

    const previous = this.baselines.get(ctx.connectionId);
    if (!previous) {
      this.baselines.set(ctx.connectionId, {
        samples: new Map(Object.entries(current)),
        lastCapturedAt: now,
      });
      return;
    }

    const intervalMs = now - previous.lastCapturedAt;
    const batch: Array<{
      command: string;
      callsDelta: number;
      usecDelta: number;
      intervalMs: number;
      capturedAt: number;
    }> = [];

    let hadReset = false;
    for (const [command, sample] of Object.entries(current)) {
      const prev = previous.samples.get(command);
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
        command,
        callsDelta,
        usecDelta,
        intervalMs,
        capturedAt: now,
      });
    }

    // Update baseline regardless — reset case also needs a fresh baseline
    this.baselines.set(ctx.connectionId, {
      samples: new Map(Object.entries(current)),
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
