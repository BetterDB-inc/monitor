import Valkey from 'iovalkey';
import { Logger } from '@nestjs/common';
import { DatabasePort, DatabaseCapabilities } from '../../common/interfaces/database-port.interface';
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
  SlotStats,
  ConfigGetResponse,
  VectorIndexInfo,
  VectorSearchResult,
  TextSearchResult,
  ProfileResult,
} from '../../common/types/metrics.types';
import {
  parseVectorIndexInfo, parseVectorSearchResponse, parseTextSearchResponse,
  parseSearchConfig, parseProfileResponse,
  sanitizeFilter, FIELD_NAME_RE, INDEX_NAME_RE,
} from '../parsers/vector-index.parser';
import type { KeyAnalyticsOptions, KeyAnalyticsResult, KeyPatternData } from '@betterdb/shared';
import { extractPattern } from '@betterdb/shared';

export interface UnifiedDatabaseAdapterConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  connectionName?: string;
}

export class UnifiedDatabaseAdapter implements DatabasePort {
  private readonly logger = new Logger(UnifiedDatabaseAdapter.name);
  private client: Valkey;
  private connected: boolean = false;
  private capabilities: DatabaseCapabilities | null = null;
  private readonly config: UnifiedDatabaseAdapterConfig;
  private cliClient: Valkey | null = null;

  private createValkeyClient(connectionName: string): Valkey {
    return new Valkey({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectionName,
    });
  }

  constructor(config: UnifiedDatabaseAdapterConfig) {
    this.config = config;
    this.client = this.createValkeyClient(config.connectionName ?? 'BetterDB-Monitor');

    this.client.on('connect', () => {
      this.connected = true;
    });

    this.client.on('error', (err) => {
      this.logger.error(`Connection error: ${err.message}`);
      this.connected = false;
    });

    this.client.on('close', () => {
      this.connected = false;
    });
  }

  async connect(): Promise<void> {
    try {
      this.logger.log(`Connecting to ${this.client.options.host}:${this.client.options.port}...`);
      await this.client.connect();
      this.connected = true;
      this.logger.log('Connected successfully');
      await this.detectCapabilities();
      this.logger.log(`Detected ${this.capabilities?.dbType} ${this.capabilities?.version}`);
    } catch (error) {
      this.connected = false;
      this.logger.error(`Connection failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.cliClient) {
      await this.cliClient.quit().catch(() => {});
      this.cliClient = null;
    }
    await this.client.quit();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.client.status === 'ready';
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
    const infoString =
      sections && sections.length > 0
        ? await this.client.info(...sections)
        : await this.client.info();
    return InfoParser.parse(infoString);
  }

  getCapabilities(): DatabaseCapabilities {
    if (!this.capabilities) {
      throw new Error('Capabilities not yet detected. Call connect() first.');
    }
    return this.capabilities;
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

    const redisSupportsSlotStats = !isValkey && (majorVersion > 8 || (majorVersion === 8 && minorVersion >= 2));

    // Probe whether CONFIG is available (disabled on managed services like AWS ElastiCache)
    let hasConfig = true;
    try {
      await this.client.config('GET', 'maxmemory');
    } catch {
      hasConfig = false;
      this.logger.warn('CONFIG command is not available (common on managed Redis services like AWS ElastiCache). Config monitoring will be disabled.');
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

    this.capabilities = {
      dbType: isValkey ? 'valkey' : 'redis',
      version,
      hasSlotStats: (isValkey && majorVersion >= 8) || redisSupportsSlotStats,
      hasCommandLog: isValkey && (majorVersion > 8 || (majorVersion === 8 && minorVersion >= 1)),  // Still Valkey-only
      hasClusterSlotStats: (isValkey && majorVersion >= 8) || redisSupportsSlotStats,
      hasLatencyMonitor: true,
      hasAclLog: majorVersion >= 6,
      hasMemoryDoctor: true,
      hasConfig,
      hasVectorSearch,
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
    const fetchCount = (excludeClientName || startTime || endTime) ? count * 5 : count;
    const rawLog = await this.client.slowlog('GET', fetchCount);
    let entries = MetricsParser.parseSlowLog(rawLog as unknown[]);

    // Filter out entries from specified client (e.g., monitor's own commands)
    if (excludeClientName) {
      entries = entries.filter(entry => entry.clientName !== excludeClientName);
    }

    if (startTime) {
      entries = entries.filter(entry => entry.timestamp >= startTime);
    }
    if (endTime) {
      entries = entries.filter(entry => entry.timestamp <= endTime);
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
    const args: string[] = commands && commands.length > 0 ? ['LATENCY', 'HISTOGRAM', ...commands] : ['LATENCY', 'HISTOGRAM'];
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

  async getClusterSlotStats(orderBy: 'key-count' | 'cpu-usec' = 'key-count', limit: number = 100): Promise<SlotStats> {
    if (!this.capabilities?.hasClusterSlotStats) {
      throw new Error('CLUSTER SLOT-STATS not supported on this database version');
    }

    // Validate and clamp limit to valid range (1 to total cluster slots)
    const validLimit = Math.max(1, Math.min(limit, CLUSTER_TOTAL_SLOTS));

    const rawStats = await this.client.call('CLUSTER', 'SLOT-STATS', 'ORDERBY', orderBy, 'LIMIT', validLimit);
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

  async collectKeyAnalytics(options: KeyAnalyticsOptions): Promise<KeyAnalyticsResult> {
    const dbSize = await this.client.dbsize();
    if (dbSize === 0) {
      return { dbSize: 0, scanned: 0, patterns: [] };
    }

    const patternsMap = new Map<string, KeyPatternData>();
    const keyDetails: Array<{
      keyName: string;
      freqScore: number | null;
      idleSeconds: number | null;
      memoryBytes: number | null;
      ttl: number | null;
    }> = [];
    let cursor = '0';
    let scanned = 0;

    do {
      const [newCursor, keys] = await this.client.scan(cursor, 'COUNT', options.scanBatchSize);
      cursor = newCursor;

      for (const key of keys) {
        if (scanned >= options.sampleSize) break;
        scanned++;

        const pattern = extractPattern(key);
        const stats = patternsMap.get(pattern) || {
          pattern,
          count: 0,
          totalMemory: 0,
          maxMemory: 0,
          totalIdleTime: 0,
          withTtl: 0,
          withoutTtl: 0,
          ttlValues: [],
          accessFrequencies: [],
        };

        try {
          const pipeline = this.client.pipeline();
          pipeline.memory('USAGE', key);
          pipeline.object('IDLETIME', key);
          pipeline.object('FREQ', key);
          pipeline.ttl(key);

          const results = (await pipeline.exec()) || [];
          const [memResult, idleResult, freqResult, ttlResult] = results;

          stats.count++;

          const mem = (memResult && !memResult[0] && memResult[1] != null) ? memResult[1] as number : null;
          if (mem !== null) {
            stats.totalMemory += mem;
            if (mem > stats.maxMemory) stats.maxMemory = mem;
          }

          const idle = (idleResult && !idleResult[0] && idleResult[1] != null) ? idleResult[1] as number : null;
          if (idle !== null) {
            stats.totalIdleTime += idle;
          }

          const freq = (freqResult && !freqResult[0] && freqResult[1] != null) ? freqResult[1] as number : null;
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
            freqScore: freq,
            idleSeconds: idle,
            memoryBytes: mem,
            ttl: ttl ?? null,
          });
        } catch (err) {
          this.logger.debug(`Failed to inspect key ${key}: ${err}`);
        }
      }

      if (scanned >= options.sampleSize) break;
    } while (cursor !== '0');

    return {
      dbSize,
      scanned,
      patterns: Array.from(patternsMap.values()),
      keyDetails,
    };
  }

  async getVectorIndexList(): Promise<string[]> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
    }
    try {
      const result = await this.client.call('FT._LIST');
      return (result as string[]) || [];
    } catch (error) {
      this.logger.error(`Failed to list vector indexes: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  async getVectorIndexInfo(indexName: string): Promise<VectorIndexInfo> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
    }
    if (!INDEX_NAME_RE.test(indexName)) {
      throw new Error(`Invalid index name: ${indexName}`);
    }
    try {
      const raw = (await this.client.call('FT.INFO', indexName)) as unknown[];
      return parseVectorIndexInfo(indexName, raw);
    } catch (error) {
      this.logger.error(`Failed to get vector index info for ${indexName}: ${error instanceof Error ? error.message : error}`);
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
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
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

  async textSearch(indexName: string, query: string, offset = 0, limit = 20): Promise<TextSearchResult> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
    }
    if (!INDEX_NAME_RE.test(indexName)) {
      throw new Error(`Invalid index name: ${indexName}`);
    }
    if (!query || query.length > 1024) {
      throw new Error('Query is required and must be under 1024 characters');
    }
    const clampedLimit = Math.min(Math.max(limit, 1), 100);
    const clampedOffset = Math.max(offset, 0);
    const args: string[] = ['FT.SEARCH', indexName, query, 'LIMIT', String(clampedOffset), String(clampedLimit)];
    // DIALECT 2 is needed for RediSearch modern query syntax but not supported by Valkey Search
    if (this.capabilities?.dbType === 'redis') {
      args.push('DIALECT', '2');
    }
    const raw = (await this.client.call(...(args as [string, ...string[]]))) as unknown[];
    return parseTextSearchResponse(raw);
  }

  async getTagValues(indexName: string, fieldName: string): Promise<string[]> {
    if (!this.capabilities?.hasVectorSearch) {
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
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
          if (v) v.split(',').forEach(tag => values.add(tag.trim()));
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
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
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
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
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
    return this.client;
  }
}
