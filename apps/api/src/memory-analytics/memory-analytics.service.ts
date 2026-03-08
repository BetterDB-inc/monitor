import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoragePort,
  StoredMemorySnapshot,
  MemorySnapshotQueryOptions,
} from '../common/interfaces/storage-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';

@Injectable()
export class MemoryAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(MemoryAnalyticsService.name);

  private readonly DEFAULT_POLL_INTERVAL_MS = 60000;

  /** Previous CPU counters per connection, for computing delta rates */
  private prevCpu = new Map<string, { sys: number; user: number; ts: number }>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return this.DEFAULT_POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting memory analytics polling (interval: ${this.getIntervalMs()}ms)`);
    this.start();
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.prevCpu.delete(connectionId);
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    try {
      const info = await ctx.client.getInfoParsed();
      const mem = info.memory;
      const now = Date.now();

      // Compute CPU delta rate
      let cpuSys = 0;
      let cpuUser = 0;
      if (info.cpu) {
        const sys = parseFloat(info.cpu.used_cpu_sys);
        const user = parseFloat(info.cpu.used_cpu_user);
        if (!isNaN(sys) && !isNaN(user)) {
          const prev = this.prevCpu.get(ctx.connectionId);
          this.prevCpu.set(ctx.connectionId, { sys, user, ts: now });
          if (prev) {
            const dtSec = (now - prev.ts) / 1000;
            if (dtSec > 0) {
              const dSys = ((sys - prev.sys) / dtSec) * 100;
              const dUser = ((user - prev.user) / dtSec) * 100;
              if (dSys >= 0 && dUser >= 0) {
                cpuSys = parseFloat(dSys.toFixed(3));
                cpuUser = parseFloat(dUser.toFixed(3));
              }
            }
          }
        }
      }

      const snapshot: StoredMemorySnapshot = {
        id: randomUUID(),
        timestamp: now,
        usedMemory: parseInt(mem?.used_memory ?? '0', 10),
        usedMemoryRss: parseInt(mem?.used_memory_rss ?? '0', 10),
        usedMemoryPeak: parseInt(mem?.used_memory_peak ?? '0', 10),
        memFragmentationRatio: parseFloat(mem?.mem_fragmentation_ratio ?? '0'),
        maxmemory: parseInt(mem?.maxmemory ?? '0', 10),
        allocatorFragRatio: parseFloat(mem?.allocator_frag_ratio ?? '0'),
        opsPerSec: parseInt(info.stats?.instantaneous_ops_per_sec ?? '0', 10),
        cpuSys,
        cpuUser,
        connectionId: ctx.connectionId,
      };

      const saved = await this.storage.saveMemorySnapshots([snapshot], ctx.connectionId);
      this.logger.debug(`Saved ${saved} memory snapshot for ${ctx.connectionName}`);
    } catch (error) {
      this.logger.error(`Error capturing memory stats for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getStoredSnapshots(options?: MemorySnapshotQueryOptions): Promise<StoredMemorySnapshot[]> {
    return this.storage.getMemorySnapshots(options);
  }

  async pruneOldEntries(retentionDays: number = 7, connectionId?: string): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldMemorySnapshots(cutoffTimestamp, connectionId);
  }
}
