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
} from '../../common/types/metrics.types';

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
        ? await this.client.info(sections.join(' '))
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

  getClient(): Valkey {
    return this.client;
  }
}
