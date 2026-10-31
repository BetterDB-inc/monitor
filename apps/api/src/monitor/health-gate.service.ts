import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { InfoParser } from '../database/parsers/info.parser';
import {
  HealthGateResult,
  HealthGateSignals,
  HealthGateThresholds,
  evaluateHealthGate,
} from './health-gate';

const REPLICA_ROLES = new Set(['slave', 'replica', 'active-replica']);
const REPLICA_LINE_KEY = /^(slave|replica)\d+$/;
const REPLICA_ACK_INTERVAL_SECONDS = 1;
const MASTER_IO_STALE_SECONDS = 30;

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
    const { replicationLagBytes, replicaLinkDown, infoFailoverInProgress } = readReplication(info);
    const now = Date.now();

    const [oomEvents, roleChangeEvents] = await Promise.all([
      this.countRecentEvents(connectionId, 'memory_used', now - this.oomWindowMs),
      this.countRecentEvents(connectionId, 'replication_role', now - this.failoverWindowMs),
    ]);

    const signals: HealthGateSignals = {
      memoryPct,
      oomEventsRecent: oomEvents,
      replicationLagBytes,
      replicaLinkDown,
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
  replicationLagBytes: number | null;
  replicaLinkDown: boolean;
  infoFailoverInProgress: boolean;
} {
  const replication = (info as { replication?: Record<string, string> }).replication;
  if (replication === undefined) {
    return { replicationLagBytes: null, replicaLinkDown: false, infoFailoverInProgress: false };
  }

  const failoverState = replication.master_failover_state;
  const infoFailoverInProgress =
    failoverState !== undefined && failoverState !== '' && failoverState !== 'no-failover';

  return {
    replicationLagBytes: furthestReplicaGap(replication),
    replicaLinkDown: REPLICA_ROLES.has(replication.role) && isMasterLinkDown(replication),
    infoFailoverInProgress,
  };
}

function isMasterLinkDown(replication: Record<string, string>): boolean {
  const linkStatus = replication.master_link_status;
  return (
    (linkStatus !== undefined && linkStatus !== 'up') ||
    replication.master_sync_in_progress === '1' ||
    toNumber(replication.master_last_io_seconds_ago) > MASTER_IO_STALE_SECONDS
  );
}

function furthestReplicaGap(replication: Record<string, string>): number | null {
  const masterOffset = parseInt(replication.master_repl_offset ?? '', 10);
  if (isNaN(masterOffset)) {
    return null;
  }
  let gap = 0;
  for (const [key, value] of Object.entries(replication)) {
    if (!REPLICA_LINE_KEY.test(key)) {
      continue;
    }
    const fields = InfoParser.parseKvLine(value, ',');
    if (fields.state !== 'online' || !isAckOverdue(fields.lag)) {
      continue;
    }
    gap = Math.max(gap, masterOffset - toNumber(fields.offset));
  }
  return gap;
}

function isAckOverdue(lagSeconds: string | undefined): boolean {
  return lagSeconds === undefined || toNumber(lagSeconds) > REPLICA_ACK_INTERVAL_SECONDS;
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
