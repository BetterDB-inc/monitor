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
const NUMBERED_MASTER_LINK_KEY = /^(master_\d+)_link_status$/;
const REPLICA_ACK_POLL_INTERVAL_MS = 100;
const REPLICA_ACK_TIMEOUT_MS = 2500;

interface ReplicaAckSample {
  primaryOffset: number;
  acks: Map<string, number>;
}

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
    const info = await this.connectionRegistry.get(connectionId).getInfoParsed();

    const memoryPct = readMemoryPct(info);
    const { replicationLagBytes, replicaLinkDown, infoFailoverInProgress } = readReplication(
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

    const result = await this.settleLag(
      connectionId,
      info,
      evaluateHealthGate(signals, this.thresholds),
    );
    if (!result.allow) {
      this.logger.debug(
        `health gate skipping ${connectionId}: ${result.skipReason} signals=${JSON.stringify(result.signals)}`,
      );
    }
    return result;
  }

  private async settleLag(
    connectionId: string,
    info: unknown,
    result: HealthGateResult,
  ): Promise<HealthGateResult> {
    const baseline = parseAckSample(readReplicationSection(info) ?? {});
    if (result.skipReason !== 'replication_lag_elevated' || baseline === null) {
      return result;
    }
    const replicationLagBytes = await this.measureLagAtNextAcks(connectionId, baseline);
    return evaluateHealthGate({ ...result.signals, replicationLagBytes }, this.thresholds);
  }

  private async measureLagAtNextAcks(
    connectionId: string,
    baseline: ReplicaAckSample,
  ): Promise<number> {
    const gaps = readReplicaGaps(baseline);
    const threshold = this.thresholds.replicationLagThresholdBytes;
    const pending = new Map(
      [...baseline.acks].filter(([, ack]) => baseline.primaryOffset - ack >= threshold),
    );
    const deadline = Date.now() + REPLICA_ACK_TIMEOUT_MS;
    let previous = baseline;

    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REPLICA_ACK_POLL_INTERVAL_MS));
      const sample = await this.readAckSample(connectionId);
      if (sample === null) {
        break;
      }
      for (const [id, baselineAck] of pending) {
        const ack = sample.acks.get(id);
        if (ack === undefined) {
          pending.delete(id);
        } else if (ack > baselineAck) {
          gaps.set(id, Math.max(0, previous.primaryOffset - ack));
          pending.delete(id);
        }
      }
      previous = sample;
    }
    return Math.max(...gaps.values());
  }

  private async readAckSample(connectionId: string): Promise<ReplicaAckSample | null> {
    try {
      const client = this.connectionRegistry.get(connectionId);
      const info = await client.getInfoParsed(['replication']);
      return parseAckSample(readReplicationSection(info) ?? {});
    } catch (err) {
      this.logger.warn(
        `health gate keeping baseline lag for ${connectionId}: ${(err as Error).message}`,
      );
      return null;
    }
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

function readReplicationSection(info: unknown): Record<string, string> | undefined {
  return (info as { replication?: Record<string, string> }).replication;
}

function readReplication(
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
    replicationLagBytes: furthestReplicaGap(replication),
    replicaLinkDown: readReplicaLinkDown(replication, replicaIoStaleSeconds),
    infoFailoverInProgress,
  };
}

function readReplicaLinkDown(
  replication: Record<string, string>,
  replicaIoStaleSeconds: number,
): boolean | null {
  const masterPrefixes = REPLICA_ROLES.has(replication.role) ? readMasterPrefixes(replication) : [];
  const links = [
    ...masterPrefixes.map((prefix) => isMasterLinkDown(replication, prefix, replicaIoStaleSeconds)),
    ...readReplicaLines(replication).map(([, fields]) =>
      isReplicaLinkDown(fields, replicaIoStaleSeconds),
    ),
  ];
  if (links.includes(true)) {
    return true;
  }
  return links.length === 0 || links.includes(null) ? null : false;
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

function isReplicaLinkDown(
  fields: Record<string, string>,
  replicaIoStaleSeconds: number,
): boolean | null {
  if (fields.state === undefined) {
    return null;
  }
  if (fields.state !== 'online') {
    return true;
  }
  const lagSeconds = parseNumber(fields.lag);
  if (readAckedOffset(fields) === null || lagSeconds === null) {
    return null;
  }
  return lagSeconds > replicaIoStaleSeconds;
}

function furthestReplicaGap(replication: Record<string, string>): number | null {
  const sample = parseAckSample(replication);
  if (sample === null) {
    return null;
  }
  if (sample.acks.size === 0) {
    return REPLICA_ROLES.has(replication.role) || hasConnectedReplicas(replication) ? null : 0;
  }
  return Math.max(...readReplicaGaps(sample).values());
}

function readReplicaGaps(sample: ReplicaAckSample): Map<string, number> {
  return new Map(
    [...sample.acks].map(([id, ack]) => [id, Math.max(0, sample.primaryOffset - ack)]),
  );
}

function hasConnectedReplicas(replication: Record<string, string>): boolean {
  return (
    toNumber(replication.connected_slaves) > 0 ||
    Object.keys(replication).some((key) => REPLICA_LINE_KEY.test(key))
  );
}

function parseAckSample(replication: Record<string, string>): ReplicaAckSample | null {
  const primaryOffset = parseNumber(replication.master_repl_offset);
  return primaryOffset === null ? null : { primaryOffset, acks: readAcks(replication) };
}

function readAcks(replication: Record<string, string>): Map<string, number> {
  const acks = new Map<string, number>();
  for (const [key, fields] of readReplicaLines(replication)) {
    const offset = readAckedOffset(fields);
    if (offset !== null) {
      const id = fields.ip === undefined ? key : `${fields.ip}:${fields.port}`;
      acks.set(id, Math.min(offset, acks.get(id) ?? offset));
    }
  }
  return acks;
}

function readReplicaLines(replication: Record<string, string>): [string, Record<string, string>][] {
  return Object.entries(replication)
    .filter(([key]) => REPLICA_LINE_KEY.test(key))
    .map(([key, value]) => [key, InfoParser.parseKvLine(value, ',')]);
}

function readAckedOffset(fields: Record<string, string>): number | null {
  const offset = parseNumber(fields.offset);
  return fields.state === 'online' && offset !== null && offset > 0 ? offset : null;
}

function parseNumber(raw: string | undefined): number | null {
  const n = parseInt(raw ?? '', 10);
  return isNaN(n) ? null : n;
}

function toNumber(raw: string | undefined): number {
  return parseNumber(raw) ?? 0;
}
