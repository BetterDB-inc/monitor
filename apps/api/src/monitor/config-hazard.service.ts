import { Injectable, Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { MetricsParser } from '../database/parsers/metrics.parser';
import {
  ConfigHazardFinding,
  evaluateAclAofHazard,
  evaluateAppendfsyncHazard,
  evaluateClusterCrcHazard,
  evaluateSentinelDnsResolutionHazard,
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

    // Sentinel is a different animal: the AOF/cluster hazards below do not apply to
    // it, but a distinct one does (blocking hostname resolution on its single loop).
    // Branch on the server mode first so a Sentinel is not probed for AOF/cluster
    // (which would only ever return spurious unverified findings there).
    if (await this.isSentinelMode(client)) {
      return this.probeSentinelDns(connectionId, client);
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

  /**
   * Whether the probed server reports itself as a Sentinel. The mode field is
   * engine/config dependent (Valkey `server_mode`, Redis / extended-compat
   * `redis_mode`, legacy `valkey_mode`), so all three are checked. INFO failures
   * degrade to "not a Sentinel" rather than throwing — the normal AOF/cluster path
   * then runs, which is the correct default for any non-Sentinel server.
   */
  private async isSentinelMode(client: ProbeClientLike): Promise<boolean> {
    try {
      const raw = await client.call('INFO', ['server']);
      if (typeof raw !== 'string') {
        return false;
      }
      const fields = this.parseInfoFields(raw);
      return [fields['server_mode'], fields['redis_mode'], fields['valkey_mode']].some((mode) => {
        return mode === 'sentinel';
      });
    } catch {
      return false;
    }
  }

  /**
   * Predictive Sentinel DNS-resolution hazard (valkey-sentinel-tilt-repro). Gathers
   * `resolve-hostnames`, the announce settings, and the monitored/replica addresses
   * from SENTINEL MASTERS / REPLICAS, best-effort, and hands them to the pure
   * evaluator. Any single read failing degrades that input rather than the probe.
   */
  private async probeSentinelDns(
    connectionId: string,
    client: ProbeClientLike,
  ): Promise<ProbeResult> {
    // Track read failures separately from genuinely-empty values: an incomplete probe
    // (a transient CONFIG GET / SENTINEL MASTERS failure) must NOT be cached as clean,
    // or a later successful read cannot restore the advisory until the cache expires.
    let readFailed = false;
    // Sentinel settings (resolve-hostnames, announce-ip, announce-hostnames) are not
    // served through the plain CONFIG GET - that exposes the standard server config
    // and returns nothing for these on a Sentinel, which would silently nil out the
    // hazard inputs so the advisory could never fire on a real Sentinel. Read them
    // through SENTINEL CONFIG GET, whose reply is a flat [name, value, ...] array
    // (same shape as CONFIG GET), consistent with the SENTINEL MASTERS call below.
    const readConfig = async (parameter: string): Promise<string | null> => {
      try {
        const raw = await client.call('SENTINEL', ['CONFIG', 'GET', parameter]);
        if (!Array.isArray(raw)) {
          return null;
        }
        for (let i = 0; i + 1 < raw.length; i += 2) {
          if (String(raw[i]) === parameter) {
            const value = String(raw[i + 1]);
            return value === '' ? null : value;
          }
        }
        return null;
      } catch (err) {
        readFailed = true;
        this.logger.debug(
          `SENTINEL CONFIG GET ${parameter} failed for ${connectionId}: ${(err as Error).message}`,
        );
        return null;
      }
    };

    const resolveHostnames = await readConfig('resolve-hostnames');
    const announceIp = await readConfig('announce-ip');
    const announceHostnames = await readConfig('announce-hostnames');

    const monitoredAddresses: string[] = [];
    // False if the address enumeration is partial (MASTERS or any REPLICAS failed), so
    // the evaluator does not read an absent hostname as conclusive.
    let monitoredAddressesComplete = true;
    try {
      const rawMasters = await client.call('SENTINEL', ['MASTERS']);
      const masters = MetricsParser.parseSentinelNodes(Array.isArray(rawMasters) ? rawMasters : []);
      for (const master of masters) {
        monitoredAddresses.push(master.ip);
        try {
          const rawReplicas = await client.call('SENTINEL', ['REPLICAS', master.name]);
          const replicas = MetricsParser.parseSentinelNodes(
            Array.isArray(rawReplicas) ? rawReplicas : [],
          );
          for (const replica of replicas) {
            monitoredAddresses.push(replica.ip);
          }
        } catch (replicaErr) {
          // A missing replica set could hide a hostname target, so the address view
          // is incomplete — do not cache this cycle's result as authoritative, and do
          // not let the evaluator read the absent hostname as conclusive.
          readFailed = true;
          monitoredAddressesComplete = false;
          this.logger.debug(
            `SENTINEL REPLICAS ${master.name} failed for ${connectionId}: ${(replicaErr as Error).message}`,
          );
        }
      }
    } catch (err) {
      readFailed = true;
      monitoredAddressesComplete = false;
      this.logger.debug(`SENTINEL MASTERS failed for ${connectionId}: ${(err as Error).message}`);
    }

    const finding = evaluateSentinelDnsResolutionHazard({
      isSentinel: true,
      resolveHostnames,
      monitoredAddresses,
      monitoredAddressesComplete,
      announceIp,
      announceHostnames,
    });
    return { findings: finding !== null ? [finding] : [], cacheable: !readFailed };
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
