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
  VectorIndexField,
  VectorIndexGcStats,
  VectorIndexDefinition,
  VectorSearchResult,
} from '../../common/types/metrics.types';
import type { KeyAnalyticsOptions, KeyAnalyticsResult, KeyPatternData } from '@betterdb/shared';
import { extractPattern } from '@betterdb/shared';

export interface UnifiedDatabaseAdapterConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export class UnifiedDatabaseAdapter implements DatabasePort {
  private readonly logger = new Logger(UnifiedDatabaseAdapter.name);
  private client: Valkey;
  private connected: boolean = false;
  private capabilities: DatabaseCapabilities | null = null;

  constructor(config: UnifiedDatabaseAdapterConfig) {
    this.client = new Valkey({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectionName: 'BetterDB-Monitor',
    });

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
    try {
      const raw = (await this.client.call('FT.INFO', indexName)) as unknown[];
      this.logger.debug(`FT.INFO raw keys for ${indexName}: ${raw.filter((_, i) => i % 2 === 0)}`);
      return this.parseVectorIndexInfo(indexName, raw);
    } catch (error) {
      this.logger.error(`Failed to get vector index info for ${indexName}: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  /** Parse a flat key-value array into a Map */
  private static toMap(arr: unknown[]): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (let i = 0; i < arr.length; i += 2) {
      m.set(String(arr[i]), arr[i + 1]);
    }
    return m;
  }

  private parseVectorIndexInfo(indexName: string, raw: unknown[]): VectorIndexInfo {
    const map = UnifiedDatabaseAdapter.toMap(raw);

    const numDocs = Number(map.get('num_docs') ?? 0);
    const numRecords = Number(map.get('num_records') ?? 0);
    const indexingFailures = Number(map.get('hash_indexing_failures') ?? 0);

    // Valkey Search: "backfill_complete_percent" (float 0-1), RediSearch: "percent_indexed"
    const percentRaw = map.get('backfill_complete_percent') ?? map.get('percent_indexed') ?? 0;
    const percentIndexed = Number(percentRaw) * 100;

    // Valkey Search: "state" ("ready"|"backfilling"|...), RediSearch: "indexing" (0|1)
    const stateRaw = map.get('state');
    const indexingRaw = map.get('indexing');
    let indexingState: string;
    if (stateRaw !== undefined) {
      indexingState = stateRaw === 'ready' ? 'indexed' : 'indexing';
    } else {
      indexingState = (indexingRaw === '1' || indexingRaw === 1) ? 'indexing' : 'indexed';
    }

    // Debug: log memory-related keys to identify the correct field
    const memoryKeys = Array.from(map.keys()).filter(k =>
      typeof k === 'string' && (k.includes('sz') || k.includes('size') || k.includes('memory')),
    );
    this.logger.debug(`FT.INFO memory keys for ${indexName}: ${memoryKeys.map(k => `${k}=${map.get(k)}`).join(', ')}`);

    let memorySizeMb = Number(map.get('vector_index_sz_mb') ?? 0);
    if (memorySizeMb === 0) {
      const inverted = Number(map.get('inverted_sz_mb') ?? 0);
      const offsetVectors = Number(map.get('offset_vectors_sz_mb') ?? 0);
      const docTable = Number(map.get('doc_table_size_mb') ?? 0);
      const keyTable = Number(map.get('key_table_size_mb') ?? 0);
      memorySizeMb = inverted + offsetVectors + docTable + keyTable;
    }

    // Parse all attributes into fields
    const fields: VectorIndexField[] = [];
    let numVectorFields = 0;
    const attributes = map.get('attributes');
    if (Array.isArray(attributes)) {
      for (const attr of attributes) {
        if (!Array.isArray(attr)) continue;
        const field = this.parseAttributeField(attr);
        fields.push(field);
        if (field.type === 'VECTOR') numVectorFields++;
      }
    }

    // Parse gc_stats (RediSearch only, absent in Valkey Search)
    const gcStats = this.parseGcStats(map.get('gc_stats'));

    // Parse index_definition
    const indexDefinition = this.parseIndexDefinition(map.get('index_definition'));

    return {
      name: indexName,
      numDocs,
      numRecords,
      numVectorFields,
      indexingState,
      percentIndexed,
      memorySizeMb,
      indexingFailures,
      fields,
      gcStats,
      indexDefinition,
    };
  }

  private parseAttributeField(attr: unknown[]): VectorIndexField {
    const attrMap = UnifiedDatabaseAdapter.toMap(attr);
    const name = String(attrMap.get('identifier') ?? attrMap.get('attribute') ?? '');
    const type = String(attrMap.get('type') ?? '').toUpperCase();

    let algorithm: string | null = null;
    let dimension: number | null = null;
    let distanceMetric: string | null = null;
    let hnswM: number | null = null;
    let hnswEfConstruction: number | null = null;
    let hnswEfRuntime: number | null = null;

    if (type === 'VECTOR') {
      // Valkey Search: vector params nested under "index" key
      const indexData = attrMap.get('index');
      if (Array.isArray(indexData)) {
        const idxMap = UnifiedDatabaseAdapter.toMap(indexData);
        dimension = Number(idxMap.get('dimensions') ?? idxMap.get('DIM') ?? null);
        if (isNaN(dimension as number)) dimension = null;
        const dm = idxMap.get('distance_metric') ?? idxMap.get('DISTANCE_METRIC');
        distanceMetric = dm != null ? String(dm) : null;
        const algoData = idxMap.get('algorithm');
        if (Array.isArray(algoData)) {
          const algoMap = UnifiedDatabaseAdapter.toMap(algoData);
          algorithm = algoMap.has('name') ? String(algoMap.get('name')) : null;
          // HNSW params from algorithm sub-array
          const m = algoMap.get('m') ?? algoMap.get('M');
          if (m != null) hnswM = Number(m);
          const efC = algoMap.get('ef_construction') ?? algoMap.get('EF_CONSTRUCTION');
          if (efC != null) hnswEfConstruction = Number(efC);
          const efR = algoMap.get('ef_runtime') ?? algoMap.get('EF_RUNTIME');
          if (efR != null) hnswEfRuntime = Number(efR);
        } else if (typeof algoData === 'string') {
          algorithm = algoData;
        }
      }

      // RediSearch: DIM/DISTANCE_METRIC/algorithm may be flat in the attribute array
      if (dimension === null && attrMap.has('DIM')) {
        dimension = Number(attrMap.get('DIM'));
      }
      if (distanceMetric === null && attrMap.has('DISTANCE_METRIC')) {
        distanceMetric = String(attrMap.get('DISTANCE_METRIC'));
      }
      if (algorithm === null && attrMap.has('algorithm') && typeof attrMap.get('algorithm') === 'string') {
        algorithm = String(attrMap.get('algorithm'));
      }
      // RediSearch: HNSW params flat in attribute array
      if (hnswM === null && (attrMap.has('M') || attrMap.has('m'))) {
        hnswM = Number(attrMap.get('M') ?? attrMap.get('m'));
      }
      if (hnswEfConstruction === null && (attrMap.has('EF_CONSTRUCTION') || attrMap.has('ef_construction'))) {
        hnswEfConstruction = Number(attrMap.get('EF_CONSTRUCTION') ?? attrMap.get('ef_construction'));
      }
      if (hnswEfRuntime === null && (attrMap.has('EF_RUNTIME') || attrMap.has('ef_runtime'))) {
        hnswEfRuntime = Number(attrMap.get('EF_RUNTIME') ?? attrMap.get('ef_runtime'));
      }
    }

    // Non-vector field attributes
    const sepRaw = attrMap.get('SEPARATOR') ?? attrMap.get('separator');
    const separator = sepRaw != null ? String(sepRaw) : null;
    const caseSensitive = attrMap.has('CASESENSITIVE') || attrMap.has('case_sensitive');
    const sortable = attrMap.has('SORTABLE') || attrMap.has('sortable');
    const noStem = attrMap.has('NOSTEM') || attrMap.has('nostem');
    const weightRaw = attrMap.get('WEIGHT') ?? attrMap.get('weight');
    const weight = weightRaw != null ? Number(weightRaw) : null;

    return {
      name, type, algorithm, dimension, distanceMetric,
      hnswM, hnswEfConstruction, hnswEfRuntime,
      separator, caseSensitive, sortable, noStem, weight,
    };
  }

  private parseGcStats(raw: unknown): VectorIndexGcStats | null {
    if (!Array.isArray(raw)) return null;
    try {
      const m = UnifiedDatabaseAdapter.toMap(raw);
      return {
        gcCycles: Number(m.get('gc_stats_cycles') ?? m.get('gc_numeric_trees_missed') ?? 0),
        bytesCollected: Number(m.get('bytes_collected') ?? 0),
        totalMsRun: Number(m.get('total_ms_run') ?? 0),
      };
    } catch {
      return null;
    }
  }

  private parseIndexDefinition(raw: unknown): VectorIndexDefinition | null {
    if (!Array.isArray(raw)) return null;
    try {
      const m = UnifiedDatabaseAdapter.toMap(raw);
      const prefixesRaw = m.get('prefixes');
      const prefixes = Array.isArray(prefixesRaw) ? prefixesRaw.map(String) : [];
      const lang = m.get('default_language');
      const score = m.get('default_score');
      return {
        prefixes,
        defaultLanguage: lang != null ? String(lang) : null,
        defaultScore: score != null ? Number(score) : null,
      };
    } catch {
      return null;
    }
  }

  async getHashFieldBuffer(key: string, field: string): Promise<Buffer | null> {
    return this.client.hgetBuffer(key, field);
  }

  private static readonly FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  async vectorSearch(
    indexName: string,
    vectorFieldName: string,
    queryVector: Buffer,
    k: number,
    filter?: string,
  ): Promise<VectorSearchResult[]> {
    if (!UnifiedDatabaseAdapter.FIELD_NAME_RE.test(vectorFieldName)) {
      throw new Error(`Invalid vector field name: ${vectorFieldName}`);
    }
    const sanitizedFilter = filter?.trim();
    if (sanitizedFilter && (sanitizedFilter.length > 1024 || /[\x00-\x1f]/.test(sanitizedFilter))) {
      throw new Error('Invalid filter: too long or contains control characters');
    }
    const prefix = sanitizedFilter ? `(${sanitizedFilter})` : '*';
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

    const results: VectorSearchResult[] = [];
    const scoreKey = `__${vectorFieldName}_score`;

    for (let i = 1; i < result.length; i += 2) {
      const key = String(result[i]);
      const fieldsArr = result[i + 1] as unknown[];
      if (!Array.isArray(fieldsArr)) continue;

      const fields: Record<string, string> = {};
      let score = 0;

      for (let j = 0; j < fieldsArr.length; j += 2) {
        const fieldName = String(fieldsArr[j]);
        const fieldValue = fieldsArr[j + 1];
        if (fieldName === scoreKey) {
          score = Number(fieldValue);
        } else if (fieldName !== vectorFieldName) {
          fields[fieldName] = String(fieldValue);
        }
      }

      results.push({ key, score, fields });
    }

    return results;
  }

  getClient(): Valkey {
    return this.client;
  }
}
