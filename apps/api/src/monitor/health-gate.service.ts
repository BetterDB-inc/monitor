import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import {
  HealthGateResult,
  HealthGateSignals,
  HealthGateThresholds,
  evaluateHealthGate,
} from './health-gate';

@Injectable()
export class HealthGateService {
  private readonly logger = new Logger(HealthGateService.name);
  private readonly oomWindowMs: number;
  private readonly failoverWindowMs: number;
  private readonly thresholds: HealthGateThresholds;

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
    configService: ConfigService,
  ) {
    this.oomWindowMs = Number(
      configService.get('MONITOR_RECENT_OOM_WINDOW_MS', 5 * 60 * 1000),
    );
    this.failoverWindowMs = Number(
      configService.get('MONITOR_RECENT_FAILOVER_WINDOW_MS', 2 * 60 * 1000),
    );
    const memoryPct = Number(configService.get('MONITOR_MEMORY_PCT_THRESHOLD', 85));
    const lagBytes = Number(
      configService.get('MONITOR_REPLICATION_LAG_BYTES', 10 * 1024 * 1024),
    );
    this.thresholds = {
      memoryPctThreshold: memoryPct / 100,
      replicationLagThresholdBytes: lagBytes,
    };
  }

  async evaluate(connectionId: string): Promise<HealthGateResult> {
    const client = this.connectionRegistry.get(connectionId);
    const info = await client.getInfoParsed();

    const memoryPct = readMemoryPct(info);
    const { replicationLagBytes, infoFailoverInProgress } = readReplication(info);
    const now = Date.now();

    const [oomEvents, roleChangeEvents] = await Promise.all([
      this.countRecentEvents(connectionId, 'memory_used', now - this.oomWindowMs),
      this.countRecentEvents(connectionId, 'replication_role', now - this.failoverWindowMs),
    ]);

    const signals: HealthGateSignals = {
      memoryPct,
      oomEventsRecent: oomEvents,
      replicationLagBytes,
      failoverInProgress: infoFailoverInProgress || roleChangeEvents > 0,
    };

    const result = evaluateHealthGate(signals, this.thresholds);
    if (!result.allow) {
      this.logger.debug(
        `health gate skipping ${connectionId}: ${result.skipReason} signals=${JSON.stringify(signals)}`,
      );
    }
    return result;
  }

  private async countRecentEvents(
    connectionId: string,
    metricType: string,
    sinceTimestamp: number,
  ): Promise<number> {
    const events = await this.storage.getAnomalyEvents({
      connectionId,
      metricType,
      startTime: sinceTimestamp,
      limit: 100,
    });
    return events.length;
  }
}

function readMemoryPct(info: unknown): number {
  const memory = (info as { memory?: Record<string, string> }).memory;
  if (memory === undefined) {
    return 0;
  }
  const used = toNumber(memory.used_memory);
  const max = toNumber(memory.maxmemory);
  if (max <= 0) {
    return 0;
  }
  return used / max;
}

function readReplication(info: unknown): {
  replicationLagBytes: number;
  infoFailoverInProgress: boolean;
} {
  const replication = (info as { replication?: Record<string, string> }).replication;
  if (replication === undefined) {
    return { replicationLagBytes: 0, infoFailoverInProgress: false };
  }

  const isPrimary = replication.role === 'master' || replication.role === 'primary';
  const lag = isPrimary ? furthestReplicaGap(replication) : 0;

  const failoverState = replication.master_failover_state;
  const infoFailoverInProgress =
    failoverState !== undefined && failoverState !== '' && failoverState !== 'no-failover';

  return { replicationLagBytes: lag, infoFailoverInProgress };
}

function furthestReplicaGap(replication: Record<string, string>): number {
  const masterOffset = toNumber(replication.master_repl_offset);
  let gap = 0;
  for (const [key, value] of Object.entries(replication)) {
    if (!/^slave\d+$/.test(key) || typeof value !== 'string') {
      continue;
    }
    const fields = new Map(
      value.split(',').map((pair) => {
        const eq = pair.indexOf('=');
        return [pair.slice(0, eq), pair.slice(eq + 1)] as const;
      }),
    );
    const offset = toNumber(fields.get('offset'));
    if (fields.get('state') !== 'online' || offset <= 0) {
      continue;
    }
    gap = Math.max(gap, masterOffset - offset);
  }
  return gap;
}

function toNumber(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const n = parseInt(raw, 10);
  if (isNaN(n)) {
    return 0;
  }
  return n;
}
