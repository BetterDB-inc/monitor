import { Injectable, Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  ConfigHazardFinding,
  evaluateAclAofHazard,
  evaluateAppendfsyncHazard,
  evaluateClusterCrcHazard,
} from './config-hazard';

interface CachedFindings {
  findings: ConfigHazardFinding[];
  expiresAt: number;
}

interface ProbeResult {
  findings: ConfigHazardFinding[];
  // Only a fully-completed probe may be cached. A partial probe (e.g. the CRC
  // read failed after AOF findings were collected) still returns what it has so
  // this poll surfaces them, but must not seed the TTL cache as a clean result.
  cacheable: boolean;
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

    const result = await this.probe(connectionId);
    if (result.cacheable) {
      this.cache.set(connectionId, {
        findings: result.findings,
        expiresAt: Date.now() + ConfigHazardService.CACHE_TTL_MS,
      });
    }
    return result.findings;
  }

  private async probe(connectionId: string): Promise<ProbeResult> {
    let client: ProbeClientLike;
    try {
      client = this.connectionRegistry.get(connectionId) as unknown as ProbeClientLike;
    } catch (err) {
      this.logger.debug(
        `Config-hazard probe skipped for ${connectionId}: ${(err as Error).message}`,
      );
      return { findings: [], cacheable: false };
    }

    let appendonly: string | null;
    try {
      appendonly = await client.getConfigValue('appendonly');
    } catch (err) {
      this.logger.debug(
        `CONFIG GET appendonly failed for ${connectionId}: ${(err as Error).message}`,
      );
      return { findings: [], cacheable: false };
    }

    const findings: ConfigHazardFinding[] = [];

    // valkey#3983 (AOF + default-user data loss) and valkey#3515 (appendfsync
    // stalls) only apply when AOF is enabled.
    if (appendonly === 'yes') {
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

      const aclFinding = evaluateAclAofHazard({ appendonly, version, aclGetUserResult });
      if (aclFinding !== null) {
        findings.push(aclFinding);
      }

      const fsyncFinding = await this.probeAppendfsync(connectionId, client, appendonly);
      if (fsyncFinding !== null) {
        findings.push(fsyncFinding);
      }
    } else {
      this.delayedFsyncTrend.delete(connectionId);
    }

    // valkey#4201: cluster bus accepting unverified messages (cluster-crc-enabled
    // off). Independent of AOF, so it runs for every connection.
    let clusterEnabled: string | null;
    let clusterCrcEnabled: string | null;
    try {
      clusterEnabled = await client.getConfigValue('cluster-enabled');
      clusterCrcEnabled = await client.getConfigValue('cluster-crc-enabled');
    } catch (err) {
      // A failed cluster read must not discard AOF findings already collected,
      // so return what we have. But the probe is incomplete, so mark it
      // uncacheable: caching now would mask the missing CRC check as a clean
      // result for a full TTL and skip re-probing on the next poll.
      this.logger.debug(
        `CONFIG GET cluster-crc probe failed for ${connectionId}: ${(err as Error).message}`,
      );
      return { findings, cacheable: false };
    }

    const crcFinding = evaluateClusterCrcHazard({ clusterEnabled, clusterCrcEnabled });
    if (crcFinding !== null) {
      findings.push(crcFinding);
    }

    // A null cluster-enabled read is a filtered/empty CONFIG GET, not a
    // completed probe: the CRC verdict is unverified, so caching now would pin a
    // false clean (or a transient unverified) for a full TTL. Re-probe next poll.
    const clusterStateUnknown = clusterEnabled === null;
    return { findings, cacheable: !clusterStateUnknown };
  }

  /**
   * Seconds on the MONITORED server's clock. LATENCY LATEST timestamps each
   * spike with the server's own `time(NULL)`, so comparing those against the
   * monitor host's `Date.now()` makes the freshness window wrong in BOTH
   * directions under clock skew: a stale spike can read as fresh, and a genuine
   * one can be suppressed. Anchoring both sides to the server removes skew from
   * the comparison entirely.
   *
   * Falls back to the local clock when TIME is unavailable — no worse than
   * comparing against the local clock unconditionally, which is what this
   * replaces.
   */
  private async readServerTimeSeconds(
    connectionId: string,
    client: ProbeClientLike,
  ): Promise<number> {
    try {
      const raw = await client.call('TIME', []);
      if (Array.isArray(raw) && raw.length > 0) {
        const seconds = parseInt(String(raw[0]), 10);
        if (Number.isFinite(seconds)) {
          return seconds;
        }
      }
    } catch (err) {
      this.logger.debug(`TIME failed for ${connectionId}: ${(err as Error).message}`);
    }
    return Math.floor(Date.now() / 1000);
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
      const nowSeconds = await this.readServerTimeSeconds(connectionId, client);
      const raw = await client.call('LATENCY', ['LATEST']);
      if (Array.isArray(raw)) {
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
