import Valkey from 'iovalkey';
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import {
  DatabasePort,
  DatabaseCapabilities,
} from '../../common/interfaces/database-port.interface';
import { InfoParser } from '../parsers/info.parser';
import { MetricsParser } from '../parsers/metrics.parser';
import { CLUSTER_TOTAL_SLOTS } from '../../common/constants/cluster.constants';
import {
  InfoResponse,
  SlowLogEntry,
  CommandLogEntry,
  CommandLogType,
  LatencyEvent,
  LatencyHistoryEntry,
  LatencyHistogram,
  MemoryStats,
  ClientInfo,
  ClientFilters,
  AclLogEntry,
  RoleInfo,
  ReplicaInfo,
  ClusterNode,
  ClusterShard,
  SlotStats,
  ConfigGetResponse,
  VectorIndexInfo,
  VectorSearchResult,
  TextSearchResult,
  ProfileResult,
  SentinelNodeInfo,
} from '../../common/types/metrics.types';
import {
  parseVectorIndexInfo,
  parseVectorSearchResponse,
  parseTextSearchResponse,
  parseSearchConfig,
  parseProfileResponse,
  sanitizeFilter,
  FIELD_NAME_RE,
  INDEX_NAME_RE,
} from '../parsers/vector-index.parser';
import type {
  KeyAnalyticsOptions,
  KeyAnalyticsResult,
  KeyDetail,
  KeyPatternData,
} from '@betterdb/shared';
import { extractPattern, pruneKeyDetails, KEY_DETAILS_PRUNE_AT, STALE_KEY_IDLE_SECONDS } from '@betterdb/shared';

import type { SshTunnelConfig } from '@betterdb/shared';
import { SshTunnelService } from '../ssh/ssh-tunnel.service';
import { tlsIdentityOptions } from './tls-servername';

export interface UnifiedDatabaseAdapterConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  connectionName?: string;
  /** Logical database index the clients SELECT on connect (defaults to 0). */
  dbIndex?: number;
  tls?: boolean;
  /** Hostname the TLS certificate is verified against when `host` is a bare IP. */
  tlsServername?: string;
  /** Optional SSH tunnel used to reach the database (secrets already decrypted). */
  sshTunnel?: SshTunnelConfig;
  /** Tunnel manager; required when sshTunnel is enabled. */
  sshTunnelService?: SshTunnelService;
  /** Stable id used to key the tunnel (defaults to a generated id). */
  connectionId?: string;
}

export const QUIT_TIMEOUT_MS = 2_000;

// Minimum per-database share of the key-analytics sample budget (capped at the
// database's own key count), so a small database next to a huge sibling still
// gets a representative sample. See collectKeyAnalytics.
export const MIN_DB_SAMPLE_SIZE = 100;

async function closeClient(client: Valkey): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const quit = client.quit().then(
    () => 'quit' as const,
    () => 'failed' as const,
  );
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), QUIT_TIMEOUT_MS);
  });
  try {
    if ((await Promise.race([quit, deadline])) !== 'quit') client.disconnect();
  } finally {
    clearTimeout(timer);
  }
}

export class UnifiedDatabaseAdapter implements DatabasePort {
  private readonly logger = new Logger(UnifiedDatabaseAdapter.name);
  // Backing field is genuinely nullable: a tunnelled adapter has no client
  // until connect() runs, and teardown discards it. Every internal read goes
  // through the `client` getter below, which throws a clear error instead of
  // letting an undefined slip through to a TypeError deep in a query method.
  private _client: Valkey | null = null;
  private get client(): Valkey {
    if (!this._client) {
      throw new Error(
        'Database connection is not established (no active client). ' +
          'The server may be unreachable or its SSH tunnel may be down.',
      );
    }
    return this._client;
  }
  private connected: boolean = false;
  private capabilities: DatabaseCapabilities | null = null;
  private readonly config: UnifiedDatabaseAdapterConfig;
  private cliClient: Valkey | null = null;
  private readonly connectionId: string;
  // Unique per adapter instance so two adapters sharing a connectionId (e.g.
  // the old and new adapter during reconnect) never collide on the same tunnel.
  private readonly tunnelKey: string;
  private readonly usesTunnel: boolean;
  private tunnelActive: boolean = false;
  // SHA256 fingerprint the SSH server presented, captured on first connect when
  // no fingerprint was pinned (trust-on-first-use). The registry reads this back
  // after a successful connect to persist it for subsequent verification.
  private observedHostKeyFingerprint?: string;
  // Host/port the Valkey clients actually dial. Rewritten to 127.0.0.1:<localPort>
  // once an SSH tunnel is established.
  private connectHost: string;
  private connectPort: number;
  // Logical database the shared client actually sits on after connect: the
  // configured dbIndex, or 0 when its SELECT was rejected and the connection
  // fell back (see doConnect). Null until a connect has run.
  private activeDbIndex: number | null = null;

  private createValkeyClient(connectionName: string, db?: number): Valkey {
    return new Valkey({
      host: this.connectHost,
      port: this.connectPort,
      username: this.config.username,
      password: this.config.password,
      // Logical database the client SELECTs on connect. Defaults to the
      // connection's configured dbIndex; key-analytics scans override it to
      // visit sibling databases discovered via INFO keyspace.
      db: db ?? this.config.dbIndex ?? 0,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectionName,
      // iovalkey does not default the TLS SNI servername from the host, so
      // SNI-routed endpoints (e.g. Traefik HostSNI in front of managed Valkey)
      // would otherwise get the default cert and a non-RESP response
      // ("Protocol error, got 'H'"). Send the hostname as servername unless it
      // is a bare IP, which SNI does not allow. Through a tunnel the socket
      // points at localhost, but the certificate is still for the real host.
      // An auto-registered node reached by IP also accepts a certificate
      // issued for the hostname its cluster announces for it.
      tls: this.config.tls ? tlsIdentityOptions(this.config.host, this.config.tlsServername) : undefined,
    });
  }

  private initClient(): void {
    const client = this.createValkeyClient(this.config.connectionName ?? 'BetterDB-Monitor');
    this._client = client;

    // Identity-guard the state writes: iovalkey emits `close` asynchronously
    // after disconnect(), so a discarded client can fire after a fresh client
    // has already connected. Without the guard, that stale `close` would flip
    // `connected` to false on a healthy connection.
    client.on('connect', () => {
      if (this._client !== client) return;
      this.connected = true;
    });

    client.on('error', (err) => {
      this.logger.error(`Connection error: ${err.message}`);
      if (this._client !== client) return;
      this.connected = false;
    });

    client.on('close', () => {
      if (this._client !== client) return;
      this.connected = false;
    });
  }

  constructor(config: UnifiedDatabaseAdapterConfig) {
    this.config = config;
    this.connectionId = config.connectionId ?? `conn:${config.host}:${config.port}`;
    this.tunnelKey = `${this.connectionId}:${randomUUID()}`;
    this.usesTunnel = !!config.sshTunnel?.enabled;
    this.connectHost = config.host;
    this.connectPort = config.port;

    if (this.usesTunnel && !config.sshTunnelService) {
      throw new Error('sshTunnelService is required when an SSH tunnel is configured');
    }

    // Without a tunnel, create the client eagerly (existing behaviour). With a
    // tunnel we must open the tunnel first (async) to know the local port, so
    // the client is created in connect().
    if (!this.usesTunnel) {
      this.initClient();
    }
  }

  private async establishTunnel(): Promise<void> {
    const tunnel = this.config.sshTunnel!;
    const service = this.config.sshTunnelService!;
    const localPort = await service.createTunnel(this.tunnelKey, {
      sshHost: tunnel.host,
      sshPort: tunnel.port,
      sshUsername: tunnel.username,
      authMethod: tunnel.authMethod,
      password: tunnel.password,
      keySource: tunnel.keySource,
      privateKey: tunnel.privateKey,
      privateKeyPath: tunnel.privateKeyPath,
      passphrase: tunnel.passphrase,
      hostKeyFingerprint: tunnel.hostKeyFingerprint,
      // Trust-on-first-use: record the key the server presents so the registry
      // can persist it and pin it on the next connect.
      onHostKey: (fingerprint) => {
        this.observedHostKeyFingerprint = fingerprint;
      },
      // If the tunnel drops on its own, stop dialing the dead local port.
      onUnexpectedClose: () => this.handleTunnelDropped(),
      remoteHost: this.config.host,
      remotePort: this.config.port,
    });
    this.connectHost = '127.0.0.1';
    this.connectPort = localPort;
    this.tunnelActive = true;
  }

  /**
   * Called when the SSH tunnel drops unexpectedly. Discards the client (so
   * iovalkey stops retrying the now-dead loopback port, whose number the OS may
   * reassign to another process) and resets state so the next connect()
   * re-establishes the tunnel.
   */
  private handleTunnelDropped(): void {
    if (!this.tunnelActive) {
      return;
    }
    this.logger.warn('SSH tunnel dropped; marking connection down until re-established');
    this.tunnelActive = false;
    this.connected = false;
    if (this._client) {
      this._client.disconnect();
      this._client = null;
    }
    // The CLI client rode the same tunnel, so it now points at the dead local
    // port too. Discard it so getCliClient() rebuilds it after re-establish.
    if (this.cliClient) {
      this.cliClient.disconnect();
      this.cliClient = null;
    }
    this.connectHost = this.config.host;
    this.connectPort = this.config.port;
  }

  private async teardownTunnel(): Promise<void> {
    if (this.tunnelActive && this.config.sshTunnelService) {
      await this.config.sshTunnelService.closeTunnel(this.tunnelKey).catch(() => {});
      this.tunnelActive = false;
      // The current client's options still point at the now-closed local port,
      // so it must be rebuilt (against a freshly established tunnel) before the
      // next connect(). Discard it and restore the pre-tunnel target.
      if (this._client) {
        this._client.disconnect();
        this._client = null;
      }
      this.connectHost = this.config.host;
      this.connectPort = this.config.port;
    }
  }

  /** The host-key fingerprint observed on connect, if learned via TOFU. */
  getObservedHostKeyFingerprint(): string | undefined {
    return this.observedHostKeyFingerprint;
  }

  private connectPromise: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    try {
      if (this.usesTunnel && !this.tunnelActive) {
        await this.establishTunnel();
      }
      if (!this._client) {
        this.initClient();
      }
      this.logger.log(`Connecting to ${this.client.options.host}:${this.client.options.port}...`);
      await this.client.connect();
      // iovalkey silently swallows a failed handshake SELECT (silentEmit), so an
      // invalid dbIndex (out of range, or SELECT rejected in cluster mode) would
      // otherwise leave the client connected and quietly running on db0. Select
      // explicitly so the failure is observable — but do NOT fail the whole
      // connection on it: dbIndex was stored-but-ignored before it was honored,
      // so stray values exist in saved configs, and a monitoring connection on
      // db0 beats a dead one (SELECT is also version-dependent on clusters —
      // illegal before Valkey 9, legal after). Fall back to db0 with a loud
      // warning; testConnection checks getActiveDbIndex() and stays strict.
      const dbIndex = this.config.dbIndex ?? 0;
      this.activeDbIndex = dbIndex;
      if (dbIndex > 0) {
        try {
          await this.client.select(dbIndex);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Only a server-side rejection means the index is unusable. A
          // transport error mid-SELECT must fail the connect instead: iovalkey
          // records the target db when SELECT is SENT and re-selects it on
          // auto-reconnect, so treating a dropped connection as "db0" would
          // leave activeDbIndex disagreeing with the client's real database
          // and mislabel every subsequent scan.
          if (!/^(ERR|NOPERM|WRONGPASS|NOAUTH)\b/i.test(message)) {
            throw error;
          }
          this.activeDbIndex = 0;
          // Pin the client's recorded target back to db0 (SELECT 0 is legal
          // everywhere, including cluster mode), so an auto-reconnect cannot
          // silently retry the rejected index and drift away from
          // activeDbIndex if the server's config changed in the meantime.
          await this.client.select(0).catch(() => undefined);
          this.logger.warn(
            `SELECT ${dbIndex} failed (${message}); ` +
              'falling back to db0 — check the connection\'s configured database index',
          );
        }
      }
      this.connected = true;
      this.logger.log('Connected successfully');
      await this.detectCapabilities();
      this.logger.log(`Detected ${this.capabilities?.dbType} ${this.capabilities?.version}`);
    } catch (error) {
      this.connected = false;
      await this.teardownTunnel();
      // A later setup step (the dbIndex SELECT, detectCapabilities) can fail
      // after the socket already connected and authenticated. teardownTunnel
      // only discards the client for a tunneled connection, so a direct
      // connection's client would otherwise stay open — leaking a live
      // session per failed attempt (e.g. each failed Test Connection call
      // with a bad dbIndex builds its own throwaway adapter).
      if (this._client) {
        this._client.disconnect();
        this._client = null;
      }
      this.logger.error(`Connection failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.cliClient) {
      await closeClient(this.cliClient);
      this.cliClient = null;
    }
    if (this._client) {
      await closeClient(this._client);
    }
    await this.teardownTunnel();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this._client?.status === 'ready';
  }

  /**
   * Logical database the shared client is actually on: the configured dbIndex,
   * or 0 when the connect-time SELECT was rejected and the connection fell
   * back. testConnection compares this against the requested index so a bad
   * dbIndex fails validation even though a live connection tolerates it.
   */
  getActiveDbIndex(): number {
    return this.activeDbIndex ?? this.config.dbIndex ?? 0;
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.client.ping();
      return response === 'PONG';
    } catch {
      return false;
    }
  }

  async getInfo(sections?: string[]): Promise<Record<string, unknown>> {
    let infoString: string;
    if (sections && sections.length > 1) {
      // Passing MULTIPLE sections to a single INFO call is a Redis 7.0+/Valkey
      // feature — Redis <7 and forks like KeyDB reject it with "ERR syntax
      // error" (breaks e.g. KeyDB→Valkey migration analysis). Fetch each section
      // separately (single-section INFO is universal) and concatenate.
      const parts = await Promise.all(sections.map((section) => this.client.info(section)));
      infoString = parts.join('\n');
    } else if (sections && sections.length === 1) {
      infoString = await this.client.info(sections[0]);
    } else {
      infoString = await this.client.info();
    }
    return InfoParser.parse(infoString);
  }

  getCapabilities(): DatabaseCapabilities {
    if (!this.capabilities) {
      throw new Error('Capabilities not yet detected. Call connect() first.');
    }
    return this.capabilities;
  }

  async refreshCapabilities(): Promise<void> {
    await this.detectCapabilities();
  }

  private async detectCapabilities(): Promise<void> {
    const info = await this.getInfo(['server']);
    const version = InfoParser.getVersion(info);

    if (!version) {
      throw new Error('Could not detect database version');
    }

    const isValkey = InfoParser.isValkey(info);
    const versionParts = version.split('.').map((v) => parseInt(v, 10));
    const majorVersion = versionParts[0] || 0;
    const minorVersion = versionParts[1] || 0;

    const redisSupportsSlotStats =
      !isValkey && (majorVersion > 8 || (majorVersion === 8 && minorVersion >= 2));

    // Sentinel mode is reported in the Server section (spelled differently per
    // engine: server_mode on Valkey unless extended-redis-compat, else redis_mode;
    // redis_mode on Redis). Captured here so a wedged Sentinel is still identifiable
    // later without a fresh INFO. See AnomalyService.connectionIsSentinel.
    const isSentinel = InfoParser.isSentinelMode(
      (info.server ?? info) as Record<string, unknown>,
    );
    if (isSentinel) {
      this.capabilities = {
        dbType: isValkey ? 'valkey' : 'redis',
        version,
        hasSlotStats: false,
        hasCommandLog: false,
        hasClusterSlotStats: false,
        hasLatencyMonitor: false,
        hasAclLog: majorVersion >= 6,
        hasMemoryDoctor: false,
        hasConfig: false,
        hasVectorSearch: false,
        clusterEnabled: false,
        isSentinel: true,
      };
      return;
    }

    // Probe whether CONFIG is available (disabled on managed services like AWS ElastiCache)
    let hasConfig = true;
    try {
      await this.client.config('GET', 'maxmemory');
    } catch {
      hasConfig = false;
      this.logger.warn(
        'CONFIG command is not available (common on managed Redis services like AWS ElastiCache). Config monitoring will be disabled.',
      );
    }

    // Probe whether FT._LIST is available (Search module loaded)
    let hasVectorSearch = false;
    try {
      const result = await this.client.call('FT._LIST');
      if (Array.isArray(result)) {
        hasVectorSearch = true;
      }
    } catch {
      // Search module not loaded
    }

    let clusterEnabled = false;
    try {
      const clusterInfo = await this.getInfo(['cluster']);
      clusterEnabled =
        (clusterInfo.cluster as Record<string, unknown> | undefined)?.cluster_enabled === '1';
    } catch {
      clusterEnabled = false;
    }

    this.capabilities = {
      dbType: isValkey ? 'valkey' : 'redis',
      version,
      hasSlotStats: (isValkey && majorVersion >= 8) || redisSupportsSlotStats,
      hasCommandLog: isValkey && (majorVersion > 8 || (majorVersion === 8 && minorVersion >= 1)), // Still Valkey-only
      hasClusterSlotStats: (isValkey && majorVersion >= 8) || redisSupportsSlotStats,
      hasLatencyMonitor: true,
      hasAclLog: majorVersion >= 6,
      hasMemoryDoctor: true,
      hasConfig,
      hasVectorSearch,
      clusterEnabled,
      // Non-Sentinel path: a Sentinel connection returns early above with
      // isSentinel: true, so reaching here means this is not a Sentinel.
      isSentinel: false,
    };
  }

  async getInfoParsed(sections?: string[]): Promise<InfoResponse> {
    const info = await this.getInfo(sections);
    return MetricsParser.parseInfoToTyped(info);
  }

  async getSlowLog(
    count: number = 10,
    excludeClientName?: string,
    startTime?: number,
    endTime?: number,
  ): Promise<SlowLogEntry[]> {
    // Fetch more entries if filtering to ensure we return enough results
    const fetchCount = excludeClientName || startTime || endTime ? count * 5 : count;
    const rawLog = await this.client.slowlog('GET', fetchCount);
    let entries = MetricsParser.parseSlowLog(rawLog as unknown[]);

    // Filter out entries from specified client (e.g., monitor's own commands)
    if (excludeClientName) {
      entries = entries.filter((entry) => entry.clientName !== excludeClientName);
    }

    if (startTime) {
      entries = entries.filter((entry) => entry.timestamp >= startTime);
    }
    if (endTime) {
      entries = entries.filter((entry) => entry.timestamp <= endTime);
    }

    return entries.slice(0, count);
  }

  async getSlowLogLength(): Promise<number> {
    return (await this.client.slowlog('LEN')) as number;
  }

  async resetSlowLog(): Promise<void> {
    await this.client.slowlog('RESET');
  }

  async getCommandLog(count: number = 10, type?: CommandLogType): Promise<CommandLogEntry[]> {
    if (!this.capabilities?.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }

    // COMMANDLOG requires a type parameter, default to 'slow' if not provided
    const logType = type || 'slow';
    const rawLog = (await this.client.call('COMMANDLOG', 'GET', count, logType)) as unknown[];

    return MetricsParser.parseCommandLog(rawLog);
  }

  async getCommandLogLength(type?: CommandLogType): Promise<number> {
    if (!this.capabilities?.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }

    // COMMANDLOG requires a type parameter, default to 'slow' if not provided
    const logType = type || 'slow';
    return (await this.client.call('COMMANDLOG', 'LEN', logType)) as number;
  }

  async resetCommandLog(type?: CommandLogType): Promise<void> {
    if (!this.capabilities?.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }

    // COMMANDLOG requires a type parameter, default to 'slow' if not provided
    const logType = type || 'slow';
    await this.client.call('COMMANDLOG', 'RESET', logType);
  }

  async getLatestLatencyEvents(): Promise<LatencyEvent[]> {
    const rawEvents = await this.client.call('LATENCY', 'LATEST');
    const events: LatencyEvent[] = [];

    for (const event of rawEvents as unknown[][]) {
      events.push({
        eventName: event[0] as string,
        timestamp: event[1] as number,
        latency: event[2] as number,
      });
    }

    return events;
  }

  async getLatencyHistory(eventName: string): Promise<LatencyHistoryEntry[]> {
    const rawHistory = await this.client.call('LATENCY', 'HISTORY', eventName);
    const history: LatencyHistoryEntry[] = [];

    for (const entry of rawHistory as unknown[][]) {
      history.push({
        timestamp: entry[0] as number,
        latency: entry[1] as number,
      });
    }

    return history;
  }

  async getLatencyHistogram(commands?: string[]): Promise<Record<string, LatencyHistogram>> {
    const args: string[] =
      commands && commands.length > 0
        ? ['LATENCY', 'HISTOGRAM', ...commands]
        : ['LATENCY', 'HISTOGRAM'];
    const rawData = await this.client.call(...(args as [string, ...string[]]));

    const result: Record<string, LatencyHistogram> = {};

    if (!Array.isArray(rawData)) {
      return result;
    }

    for (let i = 0; i < rawData.length; i += 2) {
      try {
        const commandName = rawData[i] as string;
        const details = rawData[i + 1] as unknown[];

        if (!commandName || !Array.isArray(details) || details.length < 4) {
          continue;
        }

        let calls = 0;
        const histogram: { [bucket: string]: number } = {};

        for (let j = 0; j < details.length; j++) {
          if (details[j] === 'calls') {
            calls = details[j + 1] as number;
            j++;
          } else if (details[j] === 'histogram_usec') {
            const buckets = details[j + 1] as number[];
            if (Array.isArray(buckets)) {
              for (let k = 0; k < buckets.length; k += 2) {
                const bucket = buckets[k];
                const count = buckets[k + 1];
                histogram[bucket.toString()] = count;
              }
            }
            break;
          }
        }

        result[commandName] = {
          calls,
          histogram,
        };
      } catch {
        continue;
      }
    }

    return result;
  }

  async resetLatencyEvents(eventName?: string): Promise<void> {
    if (eventName) {
      await this.client.call('LATENCY', 'RESET', eventName);
    } else {
      await this.client.call('LATENCY', 'RESET');
    }
  }

  async getLatencyDoctor(): Promise<string> {
    return (await this.client.call('LATENCY', 'DOCTOR')) as string;
  }

  async getMemoryStats(): Promise<MemoryStats> {
    const rawStats = await this.client.call('MEMORY', 'STATS');
    return MetricsParser.parseMemoryStats(rawStats as Record<string, unknown>) as MemoryStats;
  }

  async getMemoryDoctor(): Promise<string> {
    return (await this.client.call('MEMORY', 'DOCTOR')) as string;
  }

  async getClients(filters?: ClientFilters): Promise<ClientInfo[]> {
    let clientListString: string;

    if (filters?.type) {
      clientListString = (await this.client.call('CLIENT', 'LIST', 'TYPE', filters.type)) as string;
    } else if (filters?.id && filters.id.length > 0) {
      clientListString = (await this.client.call('CLIENT', 'LIST', 'ID', ...filters.id)) as string;
    } else {
      clientListString = (await this.client.call('CLIENT', 'LIST')) as string;
    }

    return MetricsParser.parseClientList(clientListString);
  }

  async getClientById(id: string): Promise<ClientInfo | null> {
    const clientListString = (await this.client.call('CLIENT', 'LIST', 'ID', id)) as string;
    const clients = MetricsParser.parseClientList(clientListString);
    return clients.length > 0 ? clients[0] : null;
  }

  async killClient(filters: ClientFilters): Promise<number> {
    if (filters.id && filters.id.length > 0) {
      let killed = 0;
      for (const id of filters.id) {
        const result = await this.client.call('CLIENT', 'KILL', 'ID', id);
        if (result === 'OK' || result === 1) {
          killed++;
        }
      }
      return killed;
    } else if (filters.type) {
      return (await this.client.call('CLIENT', 'KILL', 'TYPE', filters.type)) as number;
    } else {
      throw new Error('Must provide either id or type filter for killClient');
    }
  }

  async getAclLog(count: number = 10): Promise<AclLogEntry[]> {
    const rawLog = await this.client.call('ACL', 'LOG', count);
    return MetricsParser.parseAclLog(rawLog as unknown[]);
  }

  async resetAclLog(): Promise<void> {
    await this.client.call('ACL', 'LOG', 'RESET');
  }

  async getAclUsers(): Promise<string[]> {
    const users = await this.client.call('ACL', 'USERS');
    return users as string[];
  }

  async getAclList(): Promise<string[]> {
    const aclList = await this.client.call('ACL', 'LIST');
    return aclList as string[];
  }

  async getRole(): Promise<RoleInfo> {
    const roleData = await this.client.call('ROLE');
    const role = roleData as unknown[];
    const roleName = role[0] as string;

    if (roleName === 'master') {
      const replicationOffset = role[1] as number;
      const rawReplicas = role[2] as unknown[][];
      const replicas: ReplicaInfo[] = rawReplicas.map((r) => ({
        ip: r[0] as string,
        port: r[1] as number,
        state: r[2] as string,
        offset: r[3] as number,
        lag: r[4] as number,
      }));

      return {
        role: 'master',
        replicationOffset,
        replicas,
      };
    } else if (roleName === 'slave') {
      return {
        role: 'slave',
        masterHost: role[1] as string,
        masterPort: role[2] as number,
        masterLinkStatus: role[3] as string,
        masterReplicationOffset: role[4] as number,
      };
    } else {
      return {
        role: 'sentinel',
      };
    }
  }

  /**
   * `SENTINEL MASTERS` — every master this Sentinel monitors, with the address
   * Sentinel currently has recorded for each.
   */
  async getSentinelMasters(): Promise<SentinelNodeInfo[]> {
    const raw = await this.client.call('SENTINEL', 'MASTERS');
    return MetricsParser.parseSentinelNodes(raw as unknown[]);
  }

  /** `SENTINEL REPLICAS <master>` — the replicas Sentinel believes follow a master. */
  async getSentinelReplicas(masterName: string): Promise<SentinelNodeInfo[]> {
    const raw = await this.client.call('SENTINEL', 'REPLICAS', masterName);
    return MetricsParser.parseSentinelNodes(raw as unknown[]);
  }

  /** `SENTINEL SENTINELS <master>` — the other Sentinels monitoring a master. */
  async getSentinelPeers(masterName: string): Promise<SentinelNodeInfo[]> {
    const raw = await this.client.call('SENTINEL', 'SENTINELS', masterName);
    return MetricsParser.parseSentinelNodes(raw as unknown[]);
  }

  async getClusterInfo(): Promise<Record<string, string>> {
    const infoString = await this.client.call('CLUSTER', 'INFO');
    const lines = (infoString as string).trim().split('\n');
    const info: Record<string, string> = {};

    for (const line of lines) {
      const [key, value] = line.split(':');
      if (key && value) {
        info[key.trim()] = value.trim();
      }
    }

    return info;
  }

  async getClusterNodes(): Promise<ClusterNode[]> {
    const nodesString = await this.client.call('CLUSTER', 'NODES');
    return MetricsParser.parseClusterNodes(nodesString as string);
  }

  /**
   * Fetch the authoritative shard-grouped topology via `CLUSTER SHARDS`
   * (Valkey/Redis 7.0+). Rejects if the command is unsupported; callers that
   * only need it as a refinement should catch and degrade rather than fail.
   */
  async getClusterShards(): Promise<ClusterShard[]> {
    const raw = await this.client.call('CLUSTER', 'SHARDS');
    return MetricsParser.parseClusterShards(raw as unknown[]);
  }

  async getClusterSlotStats(
    orderBy: 'key-count' | 'cpu-usec' = 'key-count',
    limit: number = 100,
  ): Promise<SlotStats> {
    if (!this.capabilities?.hasClusterSlotStats) {
      throw new Error('CLUSTER SLOT-STATS not supported on this database version');
    }

    // Validate and clamp limit to valid range (1 to total cluster slots)
    const validLimit = Math.max(1, Math.min(limit, CLUSTER_TOTAL_SLOTS));

    const rawStats = await this.client.call(
      'CLUSTER',
      'SLOT-STATS',
      'ORDERBY',
      orderBy,
      'LIMIT',
      validLimit,
    );
    return MetricsParser.parseSlotStats(rawStats as unknown[]);
  }

  async getConfigValue(parameter: string): Promise<string | null> {
    const result = (await this.client.config('GET', parameter)) as string[];
    const config = MetricsParser.parseConfigGet(result);
    return config[parameter] || null;
  }

  async getConfigValues(pattern: string): Promise<ConfigGetResponse> {
    const result = (await this.client.config('GET', pattern)) as string[];
    return MetricsParser.parseConfigGet(result);
  }

  async getDbSize(): Promise<number> {
    return await this.client.dbsize();
  }

  async getLastSaveTime(): Promise<number> {
    return await this.client.lastsave();
  }

  /**
   * Logical databases that currently hold keys, from `INFO keyspace`
   * (`db<N>:keys=...` lines — the section only lists non-empty databases).
   * Returns [] when the section is empty or unavailable (e.g. cluster mode
   * proxies that hide it), in which case the caller falls back to scanning
   * the connection's own database.
   */
  private async listKeyspaceDatabases(): Promise<Array<{ db: number; keys: number }>> {
    try {
      // Reuse the centralized INFO keyspace parser (MetricsParser via
      // getInfoParsed) rather than a second regex: it is the single definition
      // of a db entry and already drops malformed `db<N>:` lines as raw strings.
      const { keyspace } = await this.getInfoParsed(['keyspace']);
      const dbs: Array<{ db: number; keys: number }> = [];
      for (const [key, info] of Object.entries(keyspace ?? {})) {
        const match = /^db(\d+)$/.exec(key);
        // A raw-string value is a malformed line the parser kept verbatim; only
        // typed entries with a positive key count are non-empty databases.
        if (match && typeof info === 'object' && info.keys > 0) {
          dbs.push({ db: parseInt(match[1], 10), keys: info.keys });
        }
      }
      return dbs.sort((a, b) => a.db - b.db);
    } catch (error) {
      this.logger.debug(
        `Could not list keyspace databases: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  /**
   * Scan every non-empty logical database of this instance, one result per
   * database. The databases are discovered via `INFO keyspace` rather than
   * `DBSIZE` on the connected database alone, so an instance whose keys live
   * outside the configured dbIndex (e.g. everything in db1, nothing in db0)
   * is still analyzed. Databases other than the connection's own are visited
   * through a short-lived client SELECTed onto that database — the shared
   * client never switches databases, so concurrent monitoring is unaffected.
   */
  async collectKeyAnalytics(options: KeyAnalyticsOptions): Promise<KeyAnalyticsResult[]> {
    // The shared client's ACTUAL database, which differs from config.dbIndex
    // when the connect-time SELECT fell back to db0.
    const ownDb = this.activeDbIndex ?? this.config.dbIndex ?? 0;
    const databases = await this.listKeyspaceDatabases();
    if (databases.length === 0) {
      // Empty instance or no keyspace section: preserve the single-db
      // behaviour (the dbSize === 0 early-return keeps this cheap).
      return [await this.scanDatabase(this.client, ownDb, options)];
    }

    // Sampled scans share ONE sampleSize budget across the databases instead
    // of granting each one the full budget (16 populated databases would mean
    // 16x the SCAN + per-key pipeline work per collection). The budget is
    // split proportionally to each database's key count, with a floor so a
    // small database next to a huge sibling is still represented. Deep scans
    // (fullScan) visit everything by definition and ignore sampleSize.
    const totalKeys = databases.reduce((sum, entry) => sum + entry.keys, 0);
    const sampleBudget = (keys: number): number =>
      Math.max(
        Math.min(keys, MIN_DB_SAMPLE_SIZE),
        Math.round((options.sampleSize * keys) / Math.max(1, totalKeys)),
      );

    const results: KeyAnalyticsResult[] = [];
    const failures: unknown[] = [];
    // Sequential on purpose: SCAN + per-key pipelines are heavy, and running
    // the databases one after another keeps the load on the server no higher
    // than today's single-db scan. Sibling databases share ONE scratch client
    // that SELECTs between them, so an N-database instance opens one extra
    // connection per scan rather than one per database.
    let scratch: Valkey | null = null;
    try {
      for (const { db, keys } of databases) {
        const dbOptions = { ...options, sampleSize: sampleBudget(keys) };
        if (db === ownDb) {
          try {
            results.push(await this.scanDatabase(this.client, db, dbOptions, keys));
          } catch (error) {
            failures.push(error);
            this.logger.warn(
              `Key analytics scan failed on db${db}: ${error instanceof Error ? error.message : error}`,
            );
          }
          continue;
        }
        // After a tunnel drop, connectHost/connectPort point at the real (possibly
        // bastion-only) endpoint; a scratch client built now would dial it directly
        // and bypass the tunnel. Treat the database as failed instead, mirroring
        // getCliClient's guard.
        if (this.usesTunnel && !this.tunnelActive) {
          failures.push(new Error('SSH tunnel is not established'));
          this.logger.warn(`Key analytics scan skipped on db${db}: SSH tunnel is not established`);
          continue;
        }
        try {
          if (!scratch) {
            scratch = this.createValkeyClient(
              `${this.config.connectionName ?? 'BetterDB-Monitor'}-keyscan`,
              db,
            );
            scratch.on('error', (err) => {
              this.logger.debug(`Scratch client error: ${err.message}`);
            });
            await scratch.connect();
          }
          // iovalkey silently swallows a failed handshake SELECT (silentEmit), so
          // a client that cannot SELECT this db (e.g. a restricted ACL) would
          // otherwise keep scanning the previous db while results are tagged with
          // `db`. Select explicitly so that failure surfaces as a per-db failure.
          await scratch.select(db);
          results.push(await this.scanDatabase(scratch, db, dbOptions, keys));
        } catch (error) {
          failures.push(error);
          this.logger.warn(
            `Key analytics scan failed on db${db}: ${error instanceof Error ? error.message : error}`,
          );
          // Drop a broken connection so the next database rebuilds rather than
          // reusing a dead client; a client that is still ready (e.g. a per-db
          // SELECT/scan error) is kept and reused for the remaining databases.
          if (scratch && scratch.status !== 'ready') {
            await closeClient(scratch);
            scratch = null;
          }
        }
      }
    } finally {
      if (scratch) {
        await closeClient(scratch);
      }
    }
    // An empty-database result (dbSize 0) is not a real scan of any data, so it
    // must not mask the failures of data-bearing databases: only suppress the
    // rethrow when at least one database was actually scanned with data.
    if (results.every((r) => r.dbSize === 0) && failures.length > 0) {
      throw failures[0];
    }
    return results;
  }

  private async scanDatabase(
    client: Valkey,
    db: number,
    options: KeyAnalyticsOptions,
    // Key count already known from the INFO keyspace discovery (db<N>:keys=...),
    // so the sibling-database scans skip a redundant DBSIZE round-trip. Only the
    // single-db fallback, which has no INFO count, pays for DBSIZE.
    knownKeyCount?: number,
  ): Promise<KeyAnalyticsResult> {
    const dbSize = knownKeyCount ?? (await client.dbsize());
    if (dbSize === 0) {
      return { dbSize: 0, scanned: 0, patterns: [], db };
    }

    const patternsMap = new Map<string, KeyPatternData>();
    let keyDetails: KeyDetail[] = [];
    let cursor = '0';
    let scanned = 0;

    do {
      const [newCursor, keys] = await client.scan(cursor, 'COUNT', options.scanBatchSize);
      cursor = newCursor;

      for (const key of keys) {
        if (!options.fullScan && scanned >= options.sampleSize) break;
        scanned++;

        const pattern = extractPattern(key);
        const stats = patternsMap.get(pattern) || {
          pattern,
          count: 0,
          totalMemory: 0,
          maxMemory: 0,
          totalCardinality: 0,
          maxCardinality: 0,
          totalIdleTime: 0,
          staleCount: 0,
          withTtl: 0,
          withoutTtl: 0,
          ttlValues: [],
          accessFrequencies: [],
        };

        try {
          const pipeline = client.pipeline();
          pipeline.memory('USAGE', key);
          pipeline.object('IDLETIME', key);
          pipeline.object('FREQ', key);
          pipeline.ttl(key);
          pipeline.type(key);
          // Per-type size probes; wrong-type calls return WRONGTYPE errors we ignore,
          // and we read only the one matching TYPE. Single round-trip per key.
          pipeline.strlen(key);
          pipeline.llen(key);
          pipeline.hlen(key);
          pipeline.scard(key);
          pipeline.zcard(key);
          pipeline.xlen(key);

          const results = (await pipeline.exec()) || [];
          const [
            memResult,
            idleResult,
            freqResult,
            ttlResult,
            typeResult,
            strlenResult,
            llenResult,
            hlenResult,
            scardResult,
            zcardResult,
            xlenResult,
          ] = results;

          stats.count++;

          const num = (r: [Error | null, unknown] | undefined): number | null =>
            r && !r[0] && r[1] != null ? (r[1] as number) : null;

          const mem =
            memResult && !memResult[0] && memResult[1] != null ? (memResult[1] as number) : null;
          if (mem !== null) {
            stats.totalMemory += mem;
            if (mem > stats.maxMemory) stats.maxMemory = mem;
          }

          const keyType =
            typeResult && !typeResult[0] && typeResult[1] != null ? String(typeResult[1]) : null;
          let cardinality: number | null = null;
          switch (keyType) {
            case 'string':
              cardinality = num(strlenResult);
              break;
            case 'list':
              cardinality = num(llenResult);
              break;
            case 'hash':
              cardinality = num(hlenResult);
              break;
            case 'set':
              cardinality = num(scardResult);
              break;
            case 'zset':
              cardinality = num(zcardResult);
              break;
            case 'stream':
              cardinality = num(xlenResult);
              break;
          }
          if (cardinality !== null) {
            stats.totalCardinality += cardinality;
            if (cardinality > stats.maxCardinality) stats.maxCardinality = cardinality;
          }

          const idle =
            idleResult && !idleResult[0] && idleResult[1] != null
              ? (idleResult[1] as number)
              : null;
          if (idle !== null) {
            stats.totalIdleTime += idle;
            if (idle > STALE_KEY_IDLE_SECONDS) {
              stats.staleCount = (stats.staleCount ?? 0) + 1;
            }
          }

          const freq =
            freqResult && !freqResult[0] && freqResult[1] != null
              ? (freqResult[1] as number)
              : null;
          if (freq !== null) {
            stats.accessFrequencies.push(freq);
          }

          const ttl = ttlResult?.[1] as number;
          if (ttl > 0) {
            stats.withTtl++;
            stats.ttlValues.push(ttl);
          } else {
            stats.withoutTtl++;
          }

          patternsMap.set(pattern, stats);

          keyDetails.push({
            keyName: key,
            keyType,
            cardinality,
            freqScore: freq,
            idleSeconds: idle,
            memoryBytes: mem,
            ttl: ttl ?? null,
          });
        } catch (err) {
          this.logger.debug(`Failed to inspect key ${key}: ${err}`);
        }
      }

      // Bound memory during a full-keyspace scan: keep only the keys that can
      // still surface as top-N hot / largest keys downstream.
      if (keyDetails.length >= KEY_DETAILS_PRUNE_AT) {
        keyDetails = pruneKeyDetails(keyDetails);
      }

      if (!options.fullScan && scanned >= options.sampleSize) break;
    } while (cursor !== '0');

    return {
      dbSize,
      scanned,
      patterns: Array.from(patternsMap.values()),
      keyDetails: pruneKeyDetails(keyDetails),
      db,
    };
  }

  async getVectorIndexList(): Promise<string[]> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error(
        'Vector search is not available on this connection (Search module not loaded)',
      );
    }
    try {
      const result = await this.client.call('FT._LIST');
      return (result as string[]) || [];
    } catch (error) {
      this.logger.error(
        `Failed to list vector indexes: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async getVectorIndexInfo(indexName: string): Promise<VectorIndexInfo> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error(
        'Vector search is not available on this connection (Search module not loaded)',
      );
    }
    if (!INDEX_NAME_RE.test(indexName)) {
      throw new Error(`Invalid index name: ${indexName}`);
    }
    try {
      const raw = (await this.client.call('FT.INFO', indexName)) as unknown[];
      return parseVectorIndexInfo(indexName, raw);
    } catch (error) {
      this.logger.error(
        `Failed to get vector index info for ${indexName}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async getHashFieldBuffer(key: string, field: string): Promise<Buffer | null> {
    return this.client.hgetBuffer(key, field);
  }

  async vectorSearch(
    indexName: string,
    vectorFieldName: string,
    queryVector: Buffer,
    k: number,
    filter?: string,
  ): Promise<VectorSearchResult[]> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error(
        'Vector search is not available on this connection (Search module not loaded)',
      );
    }
    if (!INDEX_NAME_RE.test(indexName)) {
      throw new Error(`Invalid index name: ${indexName}`);
    }
    if (!FIELD_NAME_RE.test(vectorFieldName)) {
      throw new Error(`Invalid vector field name: ${vectorFieldName}`);
    }
    const sanitized = sanitizeFilter(filter);
    const prefix = sanitized ? `(${sanitized})` : '*';
    const result = (await this.client.call(
      'FT.SEARCH',
      indexName,
      `${prefix}=>[KNN ${k} @${vectorFieldName} $vec]`,
      'PARAMS',
      '2',
      'vec',
      queryVector,
      'DIALECT',
      '2',
    )) as unknown[];

    return parseVectorSearchResponse(result, vectorFieldName);
  }

  async textSearch(
    indexName: string,
    query: string,
    offset = 0,
    limit = 20,
  ): Promise<TextSearchResult> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error(
        'Vector search is not available on this connection (Search module not loaded)',
      );
    }
    if (!INDEX_NAME_RE.test(indexName)) {
      throw new Error(`Invalid index name: ${indexName}`);
    }
    if (!query || query.length > 1024) {
      throw new Error('Query is required and must be under 1024 characters');
    }
    const clampedLimit = Math.min(Math.max(limit, 1), 100);
    const clampedOffset = Math.max(offset, 0);
    const args: string[] = [
      'FT.SEARCH',
      indexName,
      query,
      'LIMIT',
      String(clampedOffset),
      String(clampedLimit),
    ];
    // DIALECT 2 is needed for RediSearch modern query syntax but not supported by Valkey Search
    if (this.capabilities?.dbType === 'redis') {
      args.push('DIALECT', '2');
    }
    const raw = (await this.client.call(...(args as [string, ...string[]]))) as unknown[];
    return parseTextSearchResponse(raw);
  }

  async getTagValues(indexName: string, fieldName: string): Promise<string[]> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error(
        'Vector search is not available on this connection (Search module not loaded)',
      );
    }
    if (!INDEX_NAME_RE.test(indexName)) {
      throw new Error(`Invalid index name: ${indexName}`);
    }
    if (!FIELD_NAME_RE.test(fieldName)) {
      throw new Error(`Invalid field name: ${fieldName}`);
    }
    // Try FT.TAGVALS first, then FT.SEARCH *, then give up
    try {
      const raw = await this.client.call('FT.TAGVALS', indexName, fieldName);
      return (raw as string[]) || [];
    } catch {
      // FT.TAGVALS not available — try FT.SEARCH * fallback
      try {
        const args: string[] = ['FT.SEARCH', indexName, '*', 'LIMIT', '0', '100'];
        if (this.capabilities?.dbType === 'redis') {
          args.push('DIALECT', '2');
        }
        const raw = (await this.client.call(...(args as [string, ...string[]]))) as unknown[];
        const result = parseTextSearchResponse(raw);
        const values = new Set<string>();
        for (const doc of result.results) {
          const v = doc.fields[fieldName];
          if (v) v.split(',').forEach((tag) => values.add(tag.trim()));
        }
        return [...values].sort();
      } catch {
        // Neither FT.TAGVALS nor FT.SEARCH * supported — return empty
        return [];
      }
    }
  }

  async getSearchConfig(pattern?: string): Promise<Record<string, string>> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error(
        'Vector search is not available on this connection (Search module not loaded)',
      );
    }
    try {
      const raw = await this.client.call('FT.CONFIG', 'GET', pattern || '*');
      return parseSearchConfig(raw as unknown[]);
    } catch {
      // FT.CONFIG not available (e.g., Valkey Search) — return empty config
      return {};
    }
  }

  async profileSearch(indexName: string, query: string, limited = false): Promise<ProfileResult> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error(
        'Vector search is not available on this connection (Search module not loaded)',
      );
    }
    if (!INDEX_NAME_RE.test(indexName)) {
      throw new Error(`Invalid index name: ${indexName}`);
    }
    if (!query || query.length > 1024) {
      throw new Error('Query is required and must be under 1024 characters');
    }
    try {
      const args: string[] = [indexName, 'SEARCH'];
      if (limited) args.push('LIMITED');
      args.push('QUERY', query);
      const raw = (await this.client.call('FT.PROFILE', ...args)) as unknown[];
      return parseProfileResponse(raw);
    } catch {
      // FT.PROFILE not available (e.g., Valkey Search)
      throw new Error('Query profiling (FT.PROFILE) is not available on this server');
    }
  }

  private async getCliClient(): Promise<Valkey> {
    if (this.cliClient) {
      return this.cliClient;
    }

    // After a tunnel drop, connectHost/connectPort are reset to the real
    // (possibly bastion-only) database endpoint. Building a CLI client now would
    // dial it directly and hang. Refuse until the tunnel is re-established.
    if (this.usesTunnel && !this.tunnelActive) {
      throw new Error(
        'SSH tunnel is not established; reconnect the connection before running CLI commands.',
      );
    }

    this.cliClient = this.createValkeyClient('BetterDB-CLI');
    await this.cliClient.connect();
    this.logger.log('CLI client connected');
    return this.cliClient;
  }

  async call(command: string, args: string[], options?: { cli?: boolean }): Promise<unknown> {
    if (options?.cli) {
      const cli = await this.getCliClient();
      return cli.call(command, ...args);
    }
    return this.client.call(command, ...args);
  }

  getClient(): Valkey {
    // Throws a clear "connection not established" error (via the getter) rather
    // than handing back an undefined that blows up as a TypeError in the caller.
    return this.client;
  }
}
