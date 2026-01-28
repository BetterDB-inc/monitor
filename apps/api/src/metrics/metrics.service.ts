import { Injectable, Inject } from '@nestjs/common';
import { DatabasePort } from '../common/interfaces/database-port.interface';
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
  SlowLogPatternAnalysis,
} from '../common/types/metrics.types';
import { analyzeSlowLogPatterns } from './slowlog-analyzer';

@Injectable()
export class MetricsService {
  constructor(
    @Inject('DATABASE_CLIENT')
    private readonly dbClient: DatabasePort,
  ) {}

  async getInfoParsed(sections?: string[]): Promise<InfoResponse> {
    return this.dbClient.getInfoParsed(sections);
  }

  async getSlowLog(count?: number, excludeClientName?: string, startTime?: number, endTime?: number): Promise<SlowLogEntry[]> {
    return this.dbClient.getSlowLog(count, excludeClientName, startTime, endTime);
  }

  async getSlowLogLength(): Promise<number> {
    return this.dbClient.getSlowLogLength();
  }

  async resetSlowLog(): Promise<void> {
    return this.dbClient.resetSlowLog();
  }

  async getCommandLog(count?: number, type?: CommandLogType): Promise<CommandLogEntry[]> {
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    return this.dbClient.getCommandLog(count, type);
  }

  async getCommandLogLength(type?: CommandLogType): Promise<number> {
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    return this.dbClient.getCommandLogLength(type);
  }

  async resetCommandLog(type?: CommandLogType): Promise<void> {
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    return this.dbClient.resetCommandLog(type);
  }

  async getLatestLatencyEvents(): Promise<LatencyEvent[]> {
    return this.dbClient.getLatestLatencyEvents();
  }

  async getLatencyHistory(eventName: string): Promise<LatencyHistoryEntry[]> {
    return this.dbClient.getLatencyHistory(eventName);
  }

  async getLatencyHistogram(commands?: string[]): Promise<Record<string, LatencyHistogram>> {
    return this.dbClient.getLatencyHistogram(commands);
  }

  async resetLatencyEvents(eventName?: string): Promise<void> {
    return this.dbClient.resetLatencyEvents(eventName);
  }

  async getLatencyDoctor(): Promise<string> {
    return this.dbClient.getLatencyDoctor();
  }

  async getMemoryStats(): Promise<MemoryStats> {
    return this.dbClient.getMemoryStats();
  }

  async getMemoryDoctor(): Promise<string> {
    return this.dbClient.getMemoryDoctor();
  }

  async getClients(filters?: ClientFilters): Promise<ClientInfo[]> {
    return this.dbClient.getClients(filters);
  }

  async getClientById(id: string): Promise<ClientInfo | null> {
    return this.dbClient.getClientById(id);
  }

  async killClient(filters: ClientFilters): Promise<number> {
    return this.dbClient.killClient(filters);
  }

  async getAclLog(count?: number): Promise<AclLogEntry[]> {
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasAclLog) {
      throw new Error('ACL LOG not supported on this database version');
    }
    return this.dbClient.getAclLog(count);
  }

  async resetAclLog(): Promise<void> {
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasAclLog) {
      throw new Error('ACL LOG not supported on this database version');
    }
    return this.dbClient.resetAclLog();
  }

  async getRole(): Promise<RoleInfo> {
    return this.dbClient.getRole();
  }

  async getClusterInfo(): Promise<Record<string, string>> {
    return this.dbClient.getClusterInfo();
  }

  async getClusterNodes(): Promise<ClusterNode[]> {
    return this.dbClient.getClusterNodes();
  }

  async getClusterSlotStats(orderBy?: 'key-count' | 'cpu-usec', limit?: number): Promise<SlotStats> {
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasClusterSlotStats) {
      throw new Error('CLUSTER SLOT-STATS not supported on this database version');
    }
    return this.dbClient.getClusterSlotStats(orderBy, limit);
  }

  async getConfigValue(parameter: string): Promise<string | null> {
    return this.dbClient.getConfigValue(parameter);
  }

  async getConfigValues(pattern: string): Promise<ConfigGetResponse> {
    return this.dbClient.getConfigValues(pattern);
  }

  async getDbSize(): Promise<number> {
    return this.dbClient.getDbSize();
  }

  async getLastSaveTime(): Promise<number> {
    return this.dbClient.getLastSaveTime();
  }

  async getSlowLogPatternAnalysis(
    count?: number,
  ): Promise<SlowLogPatternAnalysis> {
    const entries = await this.dbClient.getSlowLog(count || 128);
    return analyzeSlowLogPatterns(entries);
  }

  async getCommandLogPatternAnalysis(
    count?: number,
    type?: CommandLogType,
  ): Promise<SlowLogPatternAnalysis> {
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    const entries = await this.dbClient.getCommandLog(count || 128, type);
    return analyzeSlowLogPatterns(entries as SlowLogEntry[]);
  }
}
