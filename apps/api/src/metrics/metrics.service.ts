import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
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
import { StoragePort, toSlowLogEntry } from '../common/interfaces/storage-port.interface';

@Injectable()
export class MetricsService {
  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {}

  private getClient(connectionId?: string) {
    return this.connectionRegistry.get(connectionId);
  }

  async getInfoParsed(sections?: string[], connectionId?: string): Promise<InfoResponse> {
    return this.getClient(connectionId).getInfoParsed(sections);
  }

  async getSlowLog(count?: number, excludeClientName?: string, startTime?: number, endTime?: number, connectionId?: string): Promise<SlowLogEntry[]> {
    return this.getClient(connectionId).getSlowLog(count, excludeClientName, startTime, endTime);
  }

  async getSlowLogLength(connectionId?: string): Promise<number> {
    return this.getClient(connectionId).getSlowLogLength();
  }

  async resetSlowLog(connectionId?: string): Promise<void> {
    return this.getClient(connectionId).resetSlowLog();
  }

  async getCommandLog(count?: number, type?: CommandLogType, connectionId?: string): Promise<CommandLogEntry[]> {
    const client = this.getClient(connectionId);
    const capabilities = client.getCapabilities();
    if (!capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    return client.getCommandLog(count, type);
  }

  async getCommandLogLength(type?: CommandLogType, connectionId?: string): Promise<number> {
    const client = this.getClient(connectionId);
    const capabilities = client.getCapabilities();
    if (!capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    return client.getCommandLogLength(type);
  }

  async resetCommandLog(type?: CommandLogType, connectionId?: string): Promise<void> {
    const client = this.getClient(connectionId);
    const capabilities = client.getCapabilities();
    if (!capabilities.hasCommandLog) {
      throw new Error('COMMANDLOG not supported on this database version');
    }
    return client.resetCommandLog(type);
  }

  async getLatestLatencyEvents(connectionId?: string): Promise<LatencyEvent[]> {
    return this.getClient(connectionId).getLatestLatencyEvents();
  }

  async getLatencyHistory(eventName: string, connectionId?: string): Promise<LatencyHistoryEntry[]> {
    return this.getClient(connectionId).getLatencyHistory(eventName);
  }

  async getLatencyHistogram(commands?: string[], connectionId?: string): Promise<Record<string, LatencyHistogram>> {
    return this.getClient(connectionId).getLatencyHistogram(commands);
  }

  async resetLatencyEvents(eventName?: string, connectionId?: string): Promise<void> {
    return this.getClient(connectionId).resetLatencyEvents(eventName);
  }

  async getLatencyDoctor(connectionId?: string): Promise<string> {
    return this.getClient(connectionId).getLatencyDoctor();
  }

  async getMemoryStats(connectionId?: string): Promise<MemoryStats> {
    return this.getClient(connectionId).getMemoryStats();
  }

  async getMemoryDoctor(connectionId?: string): Promise<string> {
    return this.getClient(connectionId).getMemoryDoctor();
  }

  async getClients(filters?: ClientFilters, connectionId?: string): Promise<ClientInfo[]> {
    return this.getClient(connectionId).getClients(filters);
  }

  async getClientById(id: string, connectionId?: string): Promise<ClientInfo | null> {
    return this.getClient(connectionId).getClientById(id);
  }

  async killClient(filters: ClientFilters, connectionId?: string): Promise<number> {
    return this.getClient(connectionId).killClient(filters);
  }

  async getAclLog(count?: number, connectionId?: string): Promise<AclLogEntry[]> {
    const client = this.getClient(connectionId);
    const capabilities = client.getCapabilities();
    if (!capabilities.hasAclLog) {
      throw new Error('ACL LOG not supported on this database version');
    }
    return client.getAclLog(count);
  }

  async resetAclLog(connectionId?: string): Promise<void> {
    const client = this.getClient(connectionId);
    const capabilities = client.getCapabilities();
    if (!capabilities.hasAclLog) {
      throw new Error('ACL LOG not supported on this database version');
    }
    return client.resetAclLog();
  }

  async getRole(connectionId?: string): Promise<RoleInfo> {
    return this.getClient(connectionId).getRole();
  }

  async getClusterInfo(connectionId?: string): Promise<Record<string, string>> {
    return this.getClient(connectionId).getClusterInfo();
  }

  async getClusterNodes(connectionId?: string): Promise<ClusterNode[]> {
    return this.getClient(connectionId).getClusterNodes();
  }

  async getClusterSlotStats(orderBy?: 'key-count' | 'cpu-usec', limit?: number, connectionId?: string): Promise<SlotStats> {
    const client = this.getClient(connectionId);
    const capabilities = client.getCapabilities();
    if (!capabilities.hasClusterSlotStats) {
      throw new Error('CLUSTER SLOT-STATS not supported on this database version');
    }
    return client.getClusterSlotStats(orderBy, limit);
  }

  async getConfigValue(parameter: string, connectionId?: string): Promise<string | null> {
    return this.getClient(connectionId).getConfigValue(parameter);
  }

  async getConfigValues(pattern: string, connectionId?: string): Promise<ConfigGetResponse> {
    return this.getClient(connectionId).getConfigValues(pattern);
  }

  async getDbSize(connectionId?: string): Promise<number> {
    return this.getClient(connectionId).getDbSize();
  }

  async getLastSaveTime(connectionId?: string): Promise<number> {
    return this.getClient(connectionId).getLastSaveTime();
  }

  async getSlowLogPatternAnalysis(count?: number, connectionId?: string): Promise<SlowLogPatternAnalysis> {
    const resolvedConnectionId = connectionId || this.connectionRegistry.getDefaultId();
    if (!resolvedConnectionId) {
      throw new NotFoundException('No connection available');
    }

    const storedEntries = await this.storage.getSlowLogEntries({
      limit: count || 128,
      connectionId: resolvedConnectionId,
    });

    const entries: SlowLogEntry[] = storedEntries.map(toSlowLogEntry);

    return analyzeSlowLogPatterns(entries);
  }

  async getCommandLogPatternAnalysis(count?: number, type?: CommandLogType, connectionId?: string): Promise<SlowLogPatternAnalysis> {
    const resolvedConnectionId = connectionId || this.connectionRegistry.getDefaultId();
    if (!resolvedConnectionId) {
      throw new NotFoundException('No connection available');
    }

    const storedEntries = await this.storage.getCommandLogEntries({
      limit: count || 128,
      connectionId: resolvedConnectionId,
      type,
    });

    const entries: SlowLogEntry[] = storedEntries.map(toSlowLogEntry);

    return analyzeSlowLogPatterns(entries);
  }
}
