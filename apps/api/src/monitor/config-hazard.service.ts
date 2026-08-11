import { Injectable, Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  ConfigHazardFinding,
  evaluateAclAofHazard,
  evaluateAppendfsyncHazard,
} from './config-hazard';

interface CachedFindings {
  findings: ConfigHazardFinding[];
  expiresAt: number;
}

interface ProbeClientLike {
  getConfigValue(parameter: string): Promise<string | null>;
  call(command: string, args: string[]): Promise<unknown>;
  getCapabilities(): { version: string | null };
}

/**
 * Probes each connection for hazardous static configuration (valkey#3983) on
 * the health-polling path. Results are TTL-cached per connection so dashboard
 * polling does not hammer CONFIG GET / ACL GETUSER. Failed probes (missing
 * connection, CONFIG GET error) are never cached, so a transient failure at
 * startup cannot suppress the advisory as a false clean for a full TTL.
 */
@Injectable()
export class ConfigHazardService {
  private readonly logger = new Logger(ConfigHazardService.name);
  private readonly cache = new Map<string, CachedFindings>();
  // Per-connection aof_delayed_fsync trend across probes: how many consecutive
  // probes the counter rose, feeding the appendfsync hazard's escalation.
  private readonly delayedFsyncTrend = new Map<string, { last: number; streak: number }>();
  private static readonly CACHE_TTL_MS = 60_000;
  // LATENCY LATEST entries persist until LATENCY RESET, so only a spike this
  // recent counts as evidence that fsync is blocking the main thread NOW.
  private static readonly LATENCY_EVENT_FRESHNESS_S = 300;

  constructor(private readonly connectionRegistry: ConnectionRegistry) {}

  async getHazards(connectionId: string): Promise<ConfigHazardFinding[]> {
    const cached = this.cache.get(connectionId);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.findings;
    }

    const findings = await this.probe(connectionId);
    if (findings === null) {
      return [];
    }
    this.cache.set(connectionId, {
      findings,
      expiresAt: Date.now() + ConfigHazardService.CACHE_TTL_MS,
    });
    return findings;
  }

  private async probe(connectionId: string): Promise<ConfigHazardFinding[] | null> {
    let client: ProbeClientLike;
    try {
      client = this.connectionRegistry.get(connectionId) as unknown as ProbeClientLike;
    } catch (err) {
      this.logger.debug(
        `Config-hazard probe skipped for ${connectionId}: ${(err as Error).message}`,
      );
      return null;
    }

    let appendonly: string | null;
    try {
      appendonly = await client.getConfigValue('appendonly');
    } catch (err) {
      this.logger.debug(
        `CONFIG GET appendonly failed for ${connectionId}: ${(err as Error).message}`,
      );
      return null;
    }

    if (appendonly !== 'yes') {
      this.delayedFsyncTrend.delete(connectionId);
      return [];
    }

    let version: string | null;
    try {
      version = client.getCapabilities().version;
    } catch {
      version = null;
    }

    let aclGetUserResult: unknown;
    try {
      aclGetUserResult = await client.call('ACL', ['GETUSER', 'default']);
    } catch (err) {
      this.logger.debug(
        `ACL GETUSER default failed for ${connectionId}: ${(err as Error).message}`,
      );
      aclGetUserResult = 'denied';
    }

    const findings: ConfigHazardFinding[] = [];
    const aclFinding = evaluateAclAofHazard({ appendonly, version, aclGetUserResult });
    if (aclFinding !== null) {
      findings.push(aclFinding);
    }

    const fsyncFinding = await this.probeAppendfsync(connectionId, client, appendonly);
    if (fsyncFinding !== null) {
      findings.push(fsyncFinding);
    }
    return findings;
  }

  /**
   * AOF fsync-policy hazard (valkey#3515). Symptom probes are best-effort: a
   * failed INFO or LATENCY read degrades to config-only evaluation (the
   * low-severity advisory) rather than suppressing the finding or the poll.
   */
  private async probeAppendfsync(
    connectionId: string,
    client: ProbeClientLike,
    appendonly: string | null,
  ): Promise<ConfigHazardFinding | null> {
    let appendfsync: string | null;
    try {
      appendfsync = await client.getConfigValue('appendfsync');
    } catch (err) {
      this.logger.debug(
        `CONFIG GET appendfsync failed for ${connectionId}: ${(err as Error).message}`,
      );
      return null;
    }
    if (appendfsync !== 'always' && appendfsync !== 'everysec') {
      this.delayedFsyncTrend.delete(connectionId);
      return null;
    }

    let aofDelayedFsync: number | null = null;
    let aofLastWriteStatus: string | null = null;
    try {
      const raw = await client.call('INFO', ['persistence']);
      if (typeof raw === 'string') {
        const fields = this.parseInfoFields(raw);
        const delayed = parseInt(fields['aof_delayed_fsync'] ?? '', 10);
        if (Number.isFinite(delayed)) {
          aofDelayedFsync = delayed;
        }
        aofLastWriteStatus = fields['aof_last_write_status'] ?? null;
      }
    } catch (err) {
      this.logger.debug(`INFO persistence failed for ${connectionId}: ${(err as Error).message}`);
    }

    let delayedFsyncRisingStreak = 0;
    if (aofDelayedFsync !== null) {
      const prev = this.delayedFsyncTrend.get(connectionId);
      if (prev !== undefined && aofDelayedFsync > prev.last) {
        delayedFsyncRisingStreak = prev.streak + 1;
      }
      this.delayedFsyncTrend.set(connectionId, {
        last: aofDelayedFsync,
        streak: delayedFsyncRisingStreak,
      });
    }

    let latencyEvents: string[] = [];
    try {
      const raw = await client.call('LATENCY', ['LATEST']);
      if (Array.isArray(raw)) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        latencyEvents = raw
          .map((entry) => {
            if (Array.isArray(entry) === false) {
              return null;
            }
            const [event, spikeAtSeconds] = entry as unknown[];
            if (typeof event !== 'string' || typeof spikeAtSeconds !== 'number') {
              return null;
            }
            const isFresh =
              nowSeconds - spikeAtSeconds <= ConfigHazardService.LATENCY_EVENT_FRESHNESS_S;
            return isFresh === true ? event : null;
          })
          .filter((event): event is string => {
            return event !== null;
          });
      }
    } catch (err) {
      this.logger.debug(`LATENCY LATEST failed for ${connectionId}: ${(err as Error).message}`);
    }

    return evaluateAppendfsyncHazard({
      appendonly,
      appendfsync,
      aofDelayedFsync,
      delayedFsyncRisingStreak,
      aofLastWriteStatus,
      latencyEvents,
    });
  }

  private parseInfoFields(raw: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const sep = line.indexOf(':');
      if (sep <= 0) {
        continue;
      }
      fields[line.slice(0, sep)] = line.slice(sep + 1).trim();
    }
    return fields;
  }
}
