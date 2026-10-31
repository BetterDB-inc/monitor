import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { DatabasePort } from '../common/interfaces/database-port.interface';
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
const NUMBERED_MASTER_LINK_KEY = /^(master_\d+)_link_status$/;
const REPLICA_ACK_SAMPLE_GAP_MS = 1100;

@Injectable()
export class HealthGateService {
  private readonly logger = new Logger(HealthGateService.name);
  private readonly oomWindowMs: number;
  private readonly failoverWindowMs: number;
  private readonly replicaIoStaleSeconds: number;
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
    this.replicaIoStaleSeconds = Number(configService.get('MONITOR_REPLICA_IO_STALE_SEC', 30));
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
    const baseline = await client.getInfoParsed();
    const info = hasAckedReplica(baseline) ? await sampleAfterAckGap(client) : baseline;

    const memoryPct = readMemoryPct(info);
    const { replicationLagBytes, replicaLinkDown, infoFailoverInProgress } = readReplication(
      baseline,
      info,
      this.replicaIoStaleSeconds,
    );
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

async function sampleAfterAckGap(client: DatabasePort) {
  await new Promise((resolve) => setTimeout(resolve, REPLICA_ACK_SAMPLE_GAP_MS));
  return client.getInfoParsed();
}

function readReplicationSection(info: unknown): Record<string, string> | undefined {
  return (info as { replication?: Record<string, string> }).replication;
}

function hasAckedReplica(info: unknown): boolean {
  return readAckedOffsets(readReplicationSection(info) ?? {}).length > 0;
}

function readReplication(
  baseline: unknown,
  info: unknown,
  replicaIoStaleSeconds: number,
): {
  replicationLagBytes: number | null;
  replicaLinkDown: boolean | null;
  infoFailoverInProgress: boolean;
} {
  const replication = readReplicationSection(info);
  if (replication === undefined) {
    return { replicationLagBytes: null, replicaLinkDown: null, infoFailoverInProgress: false };
  }

  const failoverState = replication.master_failover_state;
  const infoFailoverInProgress =
    failoverState !== undefined && failoverState !== '' && failoverState !== 'no-failover';

  return {
    replicationLagBytes: furthestReplicaGap(readReplicationSection(baseline), replication),
    replicaLinkDown: REPLICA_ROLES.has(replication.role)
      ? readReplicaLinkDown(replication, replicaIoStaleSeconds)
      : null,
    infoFailoverInProgress,
  };
}

function readReplicaLinkDown(
  replication: Record<string, string>,
  replicaIoStaleSeconds: number,
): boolean | null {
  const links = readMasterPrefixes(replication).map((prefix) =>
    isMasterLinkDown(replication, prefix, replicaIoStaleSeconds),
  );
  if (links.includes(true)) {
    return true;
  }
  return links.includes(null) ? null : false;
}

function readMasterPrefixes(replication: Record<string, string>): string[] {
  const numbered = Object.keys(replication).flatMap((key) => {
    const match = NUMBERED_MASTER_LINK_KEY.exec(key);
    return match === null ? [] : [match[1]];
  });
  return ['master', ...numbered];
}

function isMasterLinkDown(
  replication: Record<string, string>,
  prefix: string,
  replicaIoStaleSeconds: number,
): boolean | null {
  const linkStatus = replication[`${prefix}_link_status`];
  const syncInProgress = replication[`${prefix}_sync_in_progress`];
  const lastIoSeconds = parseNumber(replication[`${prefix}_last_io_seconds_ago`]);
  if (
    (linkStatus !== undefined && linkStatus !== 'up') ||
    syncInProgress === '1' ||
    (lastIoSeconds !== null && lastIoSeconds > replicaIoStaleSeconds)
  ) {
    return true;
  }
  return linkStatus === undefined || syncInProgress === undefined || lastIoSeconds === null
    ? null
    : false;
}

function furthestReplicaGap(
  baseline: Record<string, string> | undefined,
  replication: Record<string, string>,
): number | null {
  const primaryOffset = parseNumber(baseline?.master_repl_offset);
  if (primaryOffset === null) {
    return null;
  }
  const ackedOffsets = readAckedOffsets(replication);
  if (ackedOffsets.length === 0) {
    return REPLICA_ROLES.has(replication.role) || hasConnectedReplicas(replication) ? null : 0;
  }
  return Math.max(0, primaryOffset - Math.min(...ackedOffsets));
}

function hasConnectedReplicas(replication: Record<string, string>): boolean {
  return (
    toNumber(replication.connected_slaves) > 0 ||
    Object.keys(replication).some((key) => REPLICA_LINE_KEY.test(key))
  );
}

function readAckedOffsets(replication: Record<string, string>): number[] {
  return Object.entries(replication)
    .filter(([key]) => REPLICA_LINE_KEY.test(key))
    .map(([, value]) => InfoParser.parseKvLine(value, ','))
    .filter((fields) => fields.state === 'online')
    .map((fields) => parseNumber(fields.offset))
    .filter((offset): offset is number => offset !== null && offset > 0);
}

function parseNumber(raw: string | undefined): number | null {
  const n = parseInt(raw ?? '', 10);
  return isNaN(n) ? null : n;
}

function toNumber(raw: string | undefined): number {
  return parseNumber(raw) ?? 0;
}
