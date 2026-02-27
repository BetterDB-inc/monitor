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
  ClusterNode,
  SlotStats,
  ConfigGetResponse,
} from '../types/metrics.types';
import type { KeyAnalyticsOptions, KeyAnalyticsResult } from '@betterdb/shared';

// Re-export types that are commonly needed alongside DatabasePort
export { SlowLogEntry, CommandLogEntry, CommandLogType };
import type Valkey from 'iovalkey';

export interface DatabaseCapabilities {
  dbType: 'valkey' | 'redis';
  version: string;
  hasCommandLog: boolean;
  hasSlotStats: boolean;
  hasClusterSlotStats: boolean;
  hasLatencyMonitor: boolean;
  hasAclLog: boolean;
  hasMemoryDoctor: boolean;
  hasConfig: boolean;
}

export interface DatabasePort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  ping(): Promise<boolean>;
  getInfo(sections?: string[]): Promise<Record<string, unknown>>;
  getCapabilities(): DatabaseCapabilities;
  getInfoParsed(sections?: string[]): Promise<InfoResponse>;
  getSlowLog(count?: number, excludeClientName?: string, startTime?: number, endTime?: number): Promise<SlowLogEntry[]>;
  getSlowLogLength(): Promise<number>;
  resetSlowLog(): Promise<void>;
  getCommandLog(count?: number, type?: CommandLogType): Promise<CommandLogEntry[]>;
  getCommandLogLength(type?: CommandLogType): Promise<number>;
  resetCommandLog(type?: CommandLogType): Promise<void>;
  getLatestLatencyEvents(): Promise<LatencyEvent[]>;
  getLatencyHistory(eventName: string): Promise<LatencyHistoryEntry[]>;
  getLatencyHistogram(commands?: string[]): Promise<Record<string, LatencyHistogram>>;
  resetLatencyEvents(eventName?: string): Promise<void>;
  getLatencyDoctor(): Promise<string>;
  getMemoryStats(): Promise<MemoryStats>;
  getMemoryDoctor(): Promise<string>;
  getClients(filters?: ClientFilters): Promise<ClientInfo[]>;
  getClientById(id: string): Promise<ClientInfo | null>;
  killClient(filters: ClientFilters): Promise<number>;
  getAclLog(count?: number): Promise<AclLogEntry[]>;
  resetAclLog(): Promise<void>;
  getAclUsers(): Promise<string[]>;
  getAclList(): Promise<string[]>;
  getRole(): Promise<RoleInfo>;
  getClusterInfo(): Promise<Record<string, string>>;
  getClusterNodes(): Promise<ClusterNode[]>;
  getClusterSlotStats(orderBy?: 'key-count' | 'cpu-usec', limit?: number): Promise<SlotStats>;
  getConfigValue(parameter: string): Promise<string | null>;
  getConfigValues(pattern: string): Promise<ConfigGetResponse>;
  getDbSize(): Promise<number>;
  getLastSaveTime(): Promise<number>;
  collectKeyAnalytics(options: KeyAnalyticsOptions): Promise<KeyAnalyticsResult>;
  getClient(): Valkey;
}
