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
  isLagAtLimit,
} from './health-gate';

const REPLICA_ROLES = new Set(['slave', 'replica', 'active-replica']);
const REPLICA_LINE_KEY = /^(slave|replica)\d+$/;
const NUMBERED_MASTER_LINK_KEY = /^(master_\d+)_link_status$/;
const REPLICA_ACK_POLL_INTERVAL_MS = 100;
const REPLICA_ACK_TIMEOUT_MS = 2500;
const GATE_RESULT_TTL_MS = 1000;

interface ReplicaAckSample {
  primaryOffset: number;
  acks: Map<string, number>;
}

type ReplicaLine = [string, Record<string, string>];

interface SharedGate {
  result: Promise<HealthGateResult>;
  expiresAt: number;
}

@Injectable()
export class HealthGateService {
  private readonly logger = new Logger(HealthGateService.name);
  private readonly oomWindowMs: number;
  private readonly failoverWindowMs: number;
  private readonly replicaIoStaleSeconds: number;
  private readonly thresholds: HealthGateThresholds;
  private readonly settledGates = new Map<string, SharedGate>();
  private readonly advisoryGates = new Map<string, SharedGate>();

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

  evaluate(connectionId: string): Promise<HealthGateResult> {
    return this.share(this.settledGates, connectionId, () => this.readGate(connectionId, true));
  }

  evaluateAdvisory(connectionId: string): Promise<HealthGateResult> {
    return this.share(this.advisoryGates, connectionId, () => this.readGate(connectionId, false));
  }

  private share(
    gates: Map<string, SharedGate>,
    connectionId: string,
    read: () => Promise<HealthGateResult>,
  ): Promise<HealthGateResult> {
    const now = Date.now();
    const known = gates.get(connectionId);
    if (known !== undefined && known.expiresAt > now) {
      return known.result;
    }
    for (const [id, gate] of gates) {
      if (gate.expiresAt <= now) {
        gates.delete(id);
      }
    }
    const gate: SharedGate = { result: read(), expiresAt: Infinity };
    gates.set(connectionId, gate);
    gate.result.then(
      () => {
        gate.expiresAt = Date.now() + GATE_RESULT_TTL_MS;
      },
      () => {
        if (gates.get(connectionId) === gate) {
          gates.delete(connectionId);
        }
      },
    );
    return gate.result;
  }

  private async readGate(connectionId: string, settle: boolean): Promise<HealthGateResult> {
    const info = await this.connectionRegistry
      .get(connectionId)
      .getInfoParsed(['memory', 'replication']);

    const memoryPct = readMemoryPct(info);
    const { replicationLagBytes, replicaLinkDown, infoFailoverInProgress, ackSample } =
      readReplication(info, this.replicaIoStaleSeconds);
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

    const firstResult = evaluateHealthGate(signals, this.thresholds);
    const result =
      settle && ackSample !== null
        ? await this.settleLag(connectionId, ackSample, firstResult)
        : firstResult;
    if (!result.allow) {
      this.logger.debug(
        `health gate skipping ${connectionId}: ${result.skipReason} signals=${JSON.stringify(result.signals)}`,
      );
    }
    return result;
  }

  private async settleLag(
    connectionId: string,
    baseline: ReplicaAckSample,
    result: HealthGateResult,
  ): Promise<HealthGateResult> {
    const gaps = readReplicaGaps(baseline);
    if (
      result.skipReason !== 'replication_lag_elevated' ||
      ![...gaps.values()].some((gap) => this.isBehindLimit(gap))
    ) {
      return result;
    }
    const replicationLagBytes = await this.measureLagAtNextAcks(connectionId, baseline, gaps);
    return evaluateHealthGate({ ...result.signals, replicationLagBytes }, this.thresholds);
  }

  private async measureLagAtNextAcks(
    connectionId: string,
    baseline: ReplicaAckSample,
    gaps: Map<string, number>,
  ): Promise<number> {
    const deadline = Date.now() + REPLICA_ACK_TIMEOUT_MS;
    const firstSample = await this.readAckSampleBefore(connectionId, deadline);
    if (firstSample === null) {
      return Math.max(...gaps.values());
    }

    const pending = new Map<string, number>();
    for (const [id, gap] of gaps) {
      const ack = firstSample.acks.get(id);
      if (ack === undefined || !this.isBehindLimit(gap)) {
        continue;
      }
      const freshGap = Math.max(0, firstSample.primaryOffset - ack);
      if (ack === baseline.acks.get(id) && this.isBehindLimit(freshGap)) {
        pending.set(id, ack);
      } else {
        gaps.set(id, freshGap);
      }
    }

    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(REPLICA_ACK_POLL_INTERVAL_MS, deadline - Date.now())),
      );
      const sample = await this.readAckSampleBefore(connectionId, deadline);
      if (sample === null) {
        break;
      }
      for (const [id, lastAck] of pending) {
        const ack = sample.acks.get(id);
        if (ack === undefined) {
          pending.delete(id);
        } else if (ack > lastAck) {
          gaps.set(id, Math.max(0, sample.primaryOffset - ack));
          pending.delete(id);
        }
      }
    }
    return Math.max(...gaps.values());
  }

  private isBehindLimit(gap: number): boolean {
    return isLagAtLimit(gap, this.thresholds.replicationLagThresholdBytes);
  }

  private async readAckSampleBefore(
    connectionId: string,
    deadline: number,
  ): Promise<ReplicaAckSample | null> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([this.readAckSample(connectionId), expired]);
    } finally {
      clearTimeout(timer);
    }
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
  ackSample: ReplicaAckSample | null;
} {
  const replication = readReplicationSection(info);
  if (replication === undefined) {
    return {
      replicationLagBytes: null,
      replicaLinkDown: null,
      infoFailoverInProgress: false,
      ackSample: null,
    };
  }

  const failoverState = replication.master_failover_state;
  const infoFailoverInProgress =
    failoverState !== undefined && failoverState !== '' && failoverState !== 'no-failover';

  const replicaLines = readReplicaLines(replication);
  const ackSample = parseAckSample(replication, replicaLines);

  return {
    replicationLagBytes: furthestReplicaGap(replication, ackSample),
    replicaLinkDown: readReplicaLinkDown(replication, replicaLines, replicaIoStaleSeconds),
    infoFailoverInProgress,
    ackSample,
  };
}

function readReplicaLinkDown(
  replication: Record<string, string>,
  replicaLines: ReplicaLine[],
  replicaIoStaleSeconds: number,
): boolean | null {
  const masterPrefixes = REPLICA_ROLES.has(replication.role) ? readMasterPrefixes(replication) : [];
  const links = [
    ...masterPrefixes.map((prefix) => isMasterLinkDown(replication, prefix, replicaIoStaleSeconds)),
    ...replicaLines.map(([, fields]) => isReplicaLinkDown(fields, replicaIoStaleSeconds)),
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

function furthestReplicaGap(
  replication: Record<string, string>,
  sample: ReplicaAckSample | null,
): number | null {
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

function parseAckSample(
  replication: Record<string, string>,
  replicaLines = readReplicaLines(replication),
): ReplicaAckSample | null {
  const primaryOffset = parseNumber(replication.master_repl_offset);
  return primaryOffset === null ? null : { primaryOffset, acks: readAcks(replicaLines) };
}

function readAcks(replicaLines: ReplicaLine[]): Map<string, number> {
  const acks = new Map<string, number>();
  for (const [key, fields] of replicaLines) {
    const offset = readAckedOffset(fields);
    if (offset !== null) {
      const id = fields.ip === undefined ? key : `${fields.ip}:${fields.port}`;
      acks.set(id, Math.min(offset, acks.get(id) ?? offset));
    }
  }
  return acks;
}

function readReplicaLines(replication: Record<string, string>): ReplicaLine[] {
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
