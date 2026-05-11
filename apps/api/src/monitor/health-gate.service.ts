import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import {
  HealthGateResult,
  HealthGateSignals,
  HealthGateThresholds,
  evaluateHealthGate,
  thresholdsFromEnv,
} from './health-gate';

/** Window in which a recent OOM-correlated anomaly event still counts as "active distress". */
const RECENT_OOM_WINDOW_MS = parseWindowEnv('MONITOR_RECENT_OOM_WINDOW_MS', 5 * 60 * 1000);

/** Window in which a recent replication-role change still counts as "failover in progress". */
const RECENT_FAILOVER_WINDOW_MS = parseWindowEnv(
  'MONITOR_RECENT_FAILOVER_WINDOW_MS',
  2 * 60 * 1000,
);

@Injectable()
export class HealthGateService {
  private readonly logger = new Logger(HealthGateService.name);

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
  ) {}

  /**
   * Evaluate the health gate for one connection. Pulls a fresh INFO snapshot,
   * looks up recent OOM-correlated and failover anomalies in storage, and runs
   * the pure {@link evaluateHealthGate} decision function.
   */
  async evaluate(
    connectionId: string,
    thresholds: HealthGateThresholds = thresholdsFromEnv(),
  ): Promise<HealthGateResult> {
    const client = this.connectionRegistry.get(connectionId);
    const info = await client.getInfoParsed();

    const memoryPct = readMemoryPct(info);
    const { replicationLagBytes, infoFailoverInProgress } = readReplication(info);
    const now = Date.now();

    const [oomEvents, roleChangeEvents] = await Promise.all([
      this.countRecentEvents(connectionId, 'memory_used', now - RECENT_OOM_WINDOW_MS),
      this.countRecentEvents(connectionId, 'replication_role', now - RECENT_FAILOVER_WINDOW_MS),
    ]);

    const signals: HealthGateSignals = {
      memoryPct,
      oomEventsRecent: oomEvents,
      replicationLagBytes,
      failoverInProgress: infoFailoverInProgress || roleChangeEvents > 0,
    };

    const result = evaluateHealthGate(signals, thresholds);
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
  if (!memory) return 0;
  const used = toNumber(memory.used_memory);
  const max = toNumber(memory.maxmemory);
  if (max <= 0) return 0;
  return used / max;
}

function readReplication(info: unknown): { replicationLagBytes: number; infoFailoverInProgress: boolean } {
  const replication = (info as { replication?: Record<string, string> }).replication;
  if (!replication) return { replicationLagBytes: 0, infoFailoverInProgress: false };

  const isReplica = replication.role === 'slave' || replication.role === 'replica';
  let lag = 0;
  if (isReplica) {
    const master = toNumber(replication.master_repl_offset);
    const slave = toNumber(replication.slave_repl_offset);
    lag = Math.max(0, master - slave);
  }

  const failoverState = replication.master_failover_state;
  const infoFailoverInProgress = !!failoverState && failoverState !== 'no-failover';

  return { replicationLagBytes: lag, infoFailoverInProgress };
}

function toNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

function parseWindowEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 0 ? fallbackMs : n;
}
