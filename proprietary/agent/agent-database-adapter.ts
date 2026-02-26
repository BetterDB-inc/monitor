import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { DatabasePort, DatabaseCapabilities } from '../../apps/api/src/common/interfaces/database-port.interface';
import { InfoParser } from '../../apps/api/src/database/parsers/info.parser';
import { MetricsParser } from '../../apps/api/src/database/parsers/metrics.parser';
import { CLUSTER_TOTAL_SLOTS } from '../../apps/api/src/common/constants/cluster.constants';
import type {
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
} from '../../apps/api/src/common/types/metrics.types';
import type { AgentHelloMessage } from '@betterdb/shared';

const COMMAND_TIMEOUT_MS = 15000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class AgentDatabaseAdapter implements DatabasePort {
  private capabilities: DatabaseCapabilities;
  private pendingRequests = new Map<string, PendingRequest>();
  private _connected = false;

  constructor(
    private ws: WebSocket,
    private agentHello: AgentHelloMessage,
  ) {
    this.capabilities = {
      dbType: agentHello.valkey.type,
      version: agentHello.valkey.version,
      hasCommandLog: agentHello.capabilities.includes('COMMANDLOG'),
      hasSlotStats: agentHello.capabilities.includes('CLUSTER'),
      hasClusterSlotStats: agentHello.capabilities.includes('CLUSTER'),
      hasLatencyMonitor: agentHello.capabilities.includes('LATENCY'),
      hasAclLog: agentHello.capabilities.includes('ACL'),
      hasMemoryDoctor: agentHello.capabilities.includes('MEMORY'),
    };

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'response' || msg.type === 'error') {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            if (msg.type === 'error') {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.data);
            }
          }
        }
      } catch {
        // Ignore non-JSON or malformed messages
      }
    });

    this._connected = true;
  }

  private sendCommand(cmd: string, args?: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this._connected || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Agent connection is closed'));
        return;
      }

      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Agent command timed out: ${cmd}`));
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type: 'command', cmd, args }));
    });
  }

  // --- Lifecycle ---

  async connect(): Promise<void> {
    // Already connected via WS
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    // Clean up pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Agent disconnected'));
    }
    this.pendingRequests.clear();
    this.ws.close();
  }

  isConnected(): boolean {
    return this._connected && this.ws.readyState === WebSocket.OPEN;
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.sendCommand('PING');
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  getCapabilities(): DatabaseCapabilities {
    return this.capabilities;
  }

  // --- Info ---

  async getInfo(sections?: string[]): Promise<Record<string, unknown>> {
    const raw = await this.sendCommand('INFO', sections || ['ALL']);
    return InfoParser.parse(raw as string);
  }

  async getInfoParsed(sections?: string[]): Promise<InfoResponse> {
    const info = await this.getInfo(sections);
    return MetricsParser.parseInfoToTyped(info);
  }

  // --- Slow Log ---

  async getSlowLog(
    count: number = 10,
    excludeClientName?: string,
    startTime?: number,
    endTime?: number,
  ): Promise<SlowLogEntry[]> {
    const fetchCount = (excludeClientName || startTime || endTime) ? count * 5 : count;
    const raw = await this.sendCommand('SLOWLOG', ['GET', String(fetchCount)]);
    let entries = MetricsParser.parseSlowLog(raw as unknown[]);

    if (excludeClientName) {
      entries = entries.filter(e => e.clientName !== excludeClientName);
    }
    if (startTime) {
      entries = entries.filter(e => e.timestamp >= startTime);
    }
    if (endTime) {
      entries = entries.filter(e => e.timestamp <= endTime);
    }

    return entries.slice(0, count);
  }

  async getSlowLogLength(): Promise<number> {
    return (await this.sendCommand('SLOWLOG', ['LEN'])) as number;
  }

  async resetSlowLog(): Promise<void> {
    await this.sendCommand('SLOWLOG', ['RESET']);
  }

  // --- Command Log ---

  async getCommandLog(count: number = 10, type?: CommandLogType): Promise<CommandLogEntry[]> {
    if (!this.capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    const logType = type || 'slow';
    const raw = await this.sendCommand('COMMANDLOG', ['GET', String(count), logType]);
    return MetricsParser.parseCommandLog(raw as unknown[]);
  }

  async getCommandLogLength(type?: CommandLogType): Promise<number> {
    if (!this.capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    const logType = type || 'slow';
    return (await this.sendCommand('COMMANDLOG', ['LEN', logType])) as number;
  }

  async resetCommandLog(type?: CommandLogType): Promise<void> {
    if (!this.capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    const logType = type || 'slow';
    await this.sendCommand('COMMANDLOG', ['RESET', logType]);
  }

  // --- Latency ---

  async getLatestLatencyEvents(): Promise<LatencyEvent[]> {
    const rawEvents = await this.sendCommand('LATENCY', ['LATEST']);
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
    const rawHistory = await this.sendCommand('LATENCY', ['HISTORY', eventName]);
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
    const args = commands && commands.length > 0
      ? ['HISTOGRAM', ...commands]
      : ['HISTOGRAM'];
    const rawData = await this.sendCommand('LATENCY', args);

    const result: Record<string, LatencyHistogram> = {};
    if (!Array.isArray(rawData)) return result;

    for (let i = 0; i < rawData.length; i += 2) {
      try {
        const commandName = rawData[i] as string;
        const details = rawData[i + 1] as unknown[];
        if (!commandName || !Array.isArray(details) || details.length < 4) continue;

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
                histogram[buckets[k].toString()] = buckets[k + 1];
              }
            }
            break;
          }
        }

        result[commandName] = { calls, histogram };
      } catch {
        continue;
      }
    }

    return result;
  }

  async resetLatencyEvents(eventName?: string): Promise<void> {
    const args = eventName ? ['RESET', eventName] : ['RESET'];
    await this.sendCommand('LATENCY', args);
  }

  async getLatencyDoctor(): Promise<string> {
    return (await this.sendCommand('LATENCY', ['DOCTOR'])) as string;
  }

  // --- Memory ---

  async getMemoryStats(): Promise<MemoryStats> {
    const raw = await this.sendCommand('MEMORY', ['STATS']);
    return MetricsParser.parseMemoryStats(raw as Record<string, unknown>) as MemoryStats;
  }

  async getMemoryDoctor(): Promise<string> {
    return (await this.sendCommand('MEMORY', ['DOCTOR'])) as string;
  }

  // --- Clients ---

  async getClients(filters?: ClientFilters): Promise<ClientInfo[]> {
    let args: string[];
    if (filters?.type) {
      args = ['LIST', 'TYPE', filters.type];
    } else if (filters?.id && filters.id.length > 0) {
      args = ['LIST', 'ID', ...filters.id];
    } else {
      args = ['LIST'];
    }
    const raw = await this.sendCommand('CLIENT', args);
    return MetricsParser.parseClientList(raw as string);
  }

  async getClientById(id: string): Promise<ClientInfo | null> {
    const raw = await this.sendCommand('CLIENT', ['LIST', 'ID', id]);
    const clients = MetricsParser.parseClientList(raw as string);
    return clients.length > 0 ? clients[0] : null;
  }

  async killClient(_filters: ClientFilters): Promise<number> {
    throw new Error('killClient is not supported through agent connections');
  }

  // --- ACL ---

  async getAclLog(count: number = 10): Promise<AclLogEntry[]> {
    const raw = await this.sendCommand('ACL', ['LOG', String(count)]);
    return MetricsParser.parseAclLog(raw as unknown[]);
  }

  async resetAclLog(): Promise<void> {
    await this.sendCommand('ACL', ['LOG', 'RESET']);
  }

  async getAclUsers(): Promise<string[]> {
    return (await this.sendCommand('ACL', ['USERS'])) as string[];
  }

  async getAclList(): Promise<string[]> {
    return (await this.sendCommand('ACL', ['LIST'])) as string[];
  }

  // --- Role ---

  async getRole(): Promise<RoleInfo> {
    const roleData = await this.sendCommand('ROLE');
    const role = roleData as unknown[];
    const roleName = role[0] as string;

    if (roleName === 'master') {
      const replicationOffset = role[1] as number;
      const rawReplicas = role[2] as unknown[][];
      const replicas: ReplicaInfo[] = (rawReplicas || []).map((r) => ({
        ip: r[0] as string,
        port: r[1] as number,
        state: r[2] as string,
        offset: r[3] as number,
        lag: r[4] as number,
      }));
      return { role: 'master', replicationOffset, replicas };
    } else if (roleName === 'slave') {
      return {
        role: 'slave',
        masterHost: role[1] as string,
        masterPort: role[2] as number,
        masterLinkStatus: role[3] as string,
        masterReplicationOffset: role[4] as number,
      };
    }
    return { role: 'sentinel' };
  }

  // --- Cluster ---

  async getClusterInfo(): Promise<Record<string, string>> {
    const infoString = await this.sendCommand('CLUSTER', ['INFO']);
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
    const nodesString = await this.sendCommand('CLUSTER', ['NODES']);
    return MetricsParser.parseClusterNodes(nodesString as string);
  }

  async getClusterSlotStats(
    orderBy: 'key-count' | 'cpu-usec' = 'key-count',
    limit: number = 100,
  ): Promise<SlotStats> {
    if (!this.capabilities.hasClusterSlotStats) {
      throw new Error('CLUSTER SLOT-STATS not supported on this database version');
    }
    const validLimit = Math.max(1, Math.min(limit, CLUSTER_TOTAL_SLOTS));
    const raw = await this.sendCommand('CLUSTER', [
      'SLOT-STATS', 'ORDERBY', orderBy, 'LIMIT', String(validLimit),
    ]);
    return MetricsParser.parseSlotStats(raw as unknown[]);
  }

  // --- Config ---

  async getConfigValue(parameter: string): Promise<string | null> {
    const result = await this.sendCommand('CONFIG', ['GET', parameter]);
    const config = MetricsParser.parseConfigGet(result as string[]);
    return config[parameter] || null;
  }

  async getConfigValues(pattern: string): Promise<ConfigGetResponse> {
    const result = await this.sendCommand('CONFIG', ['GET', pattern]);
    return MetricsParser.parseConfigGet(result as string[]);
  }

  // --- Misc ---

  async getDbSize(): Promise<number> {
    return (await this.sendCommand('DBSIZE')) as number;
  }

  async getLastSaveTime(): Promise<number> {
    return (await this.sendCommand('LASTSAVE')) as number;
  }

  getClient(): never {
    throw new Error('Raw client access not available through agent connections');
  }

  // Called by the gateway when the WebSocket disconnects
  markDisconnected(): void {
    this._connected = false;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Agent disconnected'));
    }
    this.pendingRequests.clear();
  }
}
