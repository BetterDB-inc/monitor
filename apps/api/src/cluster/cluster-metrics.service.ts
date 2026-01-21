import { Injectable, Logger } from '@nestjs/common';
import Valkey from 'iovalkey';
import { ClusterDiscoveryService, DiscoveredNode } from './cluster-discovery.service';
import { MetricsParser } from '../database/parsers/metrics.parser';
import { InfoParser } from '../database/parsers/info.parser';
import { SlowLogEntry, ClientInfo, CommandLogEntry, CommandLogType } from '../common/types/metrics.types';

const MAX_KEYS_TO_CHECK_IN_SLOT = 10000;

export interface ClusterSlowlogEntry extends SlowLogEntry {
  nodeId: string;
  nodeAddress: string;
}

export interface ClusterClientEntry extends ClientInfo {
  nodeId: string;
  nodeAddress: string;
}

export interface ClusterCommandlogEntry extends CommandLogEntry {
  nodeId: string;
  nodeAddress: string;
}

export interface NodeStats {
  nodeId: string;
  nodeAddress: string;
  role: 'master' | 'replica';
  memoryUsed: number;
  memoryPeak: number;
  memoryFragmentationRatio: number;
  opsPerSec: number;
  connectedClients: number;
  blockedClients: number;
  inputKbps: number;
  outputKbps: number;
  replicationOffset?: number;
  masterLinkStatus?: string;
  masterLastIoSecondsAgo?: number;
  cpuSys?: number;
  cpuUser?: number;
  uptimeSeconds?: number;
}

export interface SlotMigration {
  slot: number;
  sourceNodeId: string;
  sourceAddress: string;
  targetNodeId: string;
  targetAddress: string;
  state: 'migrating' | 'importing';
  keysRemaining?: number;
}

@Injectable()
export class ClusterMetricsService {
  private readonly logger = new Logger(ClusterMetricsService.name);
  private loggedErrors: Set<string> = new Set();
  private readonly MAX_LOGGED_ERRORS = 500;

  constructor(private readonly discoveryService: ClusterDiscoveryService) {}

  private addLoggedError(errorKey: string): void {
    // Prevent unbounded growth
    if (this.loggedErrors.size >= this.MAX_LOGGED_ERRORS) {
      this.loggedErrors.clear();
    }
    this.loggedErrors.add(errorKey);
  }

  private clearNodeError(nodeId: string, operation: string): void {
    this.loggedErrors.delete(`${operation}-${nodeId}`);
  }

  async getClusterSlowlog(limit: number = 100): Promise<ClusterSlowlogEntry[]> {
    const nodes = await this.discoveryService.discoverNodes();
    const slowlogPromises = nodes.map((node) => this.getNodeSlowlog(node, limit));

    const results = await Promise.allSettled(slowlogPromises);

    const allEntries: ClusterSlowlogEntry[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allEntries.push(...result.value);
      } else {
        this.logger.warn(`Failed to fetch slowlog from a node: ${result.reason}`);
      }
    }

    allEntries.sort((a, b) => b.timestamp - a.timestamp);

    return allEntries.slice(0, limit);
  }

  private async getNodeSlowlog(node: DiscoveredNode, limit: number): Promise<ClusterSlowlogEntry[]> {
    try {
      const client = await this.discoveryService.getNodeConnection(node.id);
      const rawLog = await client.slowlog('GET', limit);
      const entries = MetricsParser.parseSlowLog(rawLog as unknown[]);

      // Clear error on success
      this.clearNodeError(node.id, 'slowlog');

      return entries.map((entry) => ({
        ...entry,
        nodeId: node.id,
        nodeAddress: node.address,
      }));
    } catch (error) {
      // Only log each unique error once to avoid spam
      const errorKey = `slowlog-${node.id}`;
      if (!this.loggedErrors.has(errorKey)) {
        this.logger.debug(
          `Failed to get slowlog from node ${node.id}: ${error instanceof Error ? error.message : error}`,
        );
        this.addLoggedError(errorKey);
      }
      return [];
    }
  }

  async getClusterClients(): Promise<ClusterClientEntry[]> {
    const nodes = await this.discoveryService.discoverNodes();
    const clientsPromises = nodes.map((node) => this.getNodeClients(node));

    const results = await Promise.allSettled(clientsPromises);

    const allClients: ClusterClientEntry[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allClients.push(...result.value);
      } else {
        this.logger.warn(`Failed to fetch clients from a node: ${result.reason}`);
      }
    }

    return allClients;
  }

  private async getNodeClients(node: DiscoveredNode): Promise<ClusterClientEntry[]> {
    try {
      const client = await this.discoveryService.getNodeConnection(node.id);
      const clientListString = (await client.call('CLIENT', 'LIST')) as string;
      const clients = MetricsParser.parseClientList(clientListString);

      return clients.map((client) => ({
        ...client,
        nodeId: node.id,
        nodeAddress: node.address,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to get clients from node ${node.id}: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  async getClusterCommandlog(type: CommandLogType, limit: number = 100): Promise<ClusterCommandlogEntry[]> {
    const nodes = await this.discoveryService.discoverNodes();
    const commandlogPromises = nodes.map((node) => this.getNodeCommandlog(node, type, limit));

    const results = await Promise.allSettled(commandlogPromises);

    const allEntries: ClusterCommandlogEntry[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allEntries.push(...result.value);
      } else {
        this.logger.warn(`Failed to fetch commandlog from a node: ${result.reason}`);
      }
    }

    allEntries.sort((a, b) => b.timestamp - a.timestamp);

    return allEntries.slice(0, limit);
  }

  private async getNodeCommandlog(
    node: DiscoveredNode,
    type: CommandLogType,
    limit: number,
  ): Promise<ClusterCommandlogEntry[]> {
    try {
      const client = await this.discoveryService.getNodeConnection(node.id);
      const rawLog = (await client.call('COMMANDLOG', 'GET', limit, type)) as unknown[];
      const entries = MetricsParser.parseCommandLog(rawLog);

      return entries.map((entry) => ({
        ...entry,
        nodeId: node.id,
        nodeAddress: node.address,
      }));
    } catch (error) {
      // Silently fail for nodes that don't support commandlog
      if (error instanceof Error && error.message.includes('unknown command')) {
        return [];
      }
      this.logger.error(
        `Failed to get commandlog from node ${node.id}: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  async getClusterNodeStats(): Promise<NodeStats[]> {
    const nodes = await this.discoveryService.discoverNodes();
    const statsPromises = nodes.map((node) => this.getNodeStats(node));

    const results = await Promise.allSettled(statsPromises);

    const allStats: NodeStats[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        allStats.push(result.value);
      }
      // Errors already logged at DEBUG level in getNodeStats, no need to log again
    }

    return allStats;
  }

  private async getNodeStats(node: DiscoveredNode): Promise<NodeStats | null> {
    try {
      const client = await this.discoveryService.getNodeConnection(node.id);
      const infoString = await client.info();
      const info = InfoParser.parse(infoString);

      const memoryUsed = this.parseInfoValue(info, 'memory.used_memory', 0);
      const memoryPeak = this.parseInfoValue(info, 'memory.used_memory_peak', 0);
      const memoryFragmentationRatio = this.parseInfoValue(info, 'memory.mem_fragmentation_ratio', 1);

      const opsPerSec = this.parseInfoValue(info, 'stats.instantaneous_ops_per_sec', 0);
      const inputKbps = this.parseInfoValue(info, 'stats.instantaneous_input_kbps', 0);
      const outputKbps = this.parseInfoValue(info, 'stats.instantaneous_output_kbps', 0);

      const connectedClients = this.parseInfoValue(info, 'clients.connected_clients', 0);
      const blockedClients = this.parseInfoValue(info, 'clients.blocked_clients', 0);

      const replicationOffset = this.getReplicationOffset(info, node.role);
      const masterLinkStatus = this.getInfoString(info, 'replication.master_link_status');
      const masterLastIoSecondsAgo = this.parseInfoValue(info, 'replication.master_last_io_seconds_ago');

      const cpuSys = this.parseInfoValue(info, 'cpu.used_cpu_sys');
      const cpuUser = this.parseInfoValue(info, 'cpu.used_cpu_user');

      const uptimeSeconds = this.parseInfoValue(info, 'server.uptime_in_seconds');

      // Clear error on success
      this.clearNodeError(node.id, 'stats');

      return {
        nodeId: node.id,
        nodeAddress: node.address,
        role: node.role,
        memoryUsed: memoryUsed ?? 0,
        memoryPeak: memoryPeak ?? 0,
        memoryFragmentationRatio: memoryFragmentationRatio ?? 1.0,
        opsPerSec: opsPerSec ?? 0,
        connectedClients: connectedClients ?? 0,
        blockedClients: blockedClients ?? 0,
        inputKbps: inputKbps ?? 0,
        outputKbps: outputKbps ?? 0,
        replicationOffset,
        masterLinkStatus,
        masterLastIoSecondsAgo,
        cpuSys,
        cpuUser,
        uptimeSeconds,
      };
    } catch (error) {
      // Only log each unique error once to avoid spam
      const errorKey = `stats-${node.id}`;
      if (!this.loggedErrors.has(errorKey)) {
        this.logger.debug(
          `Failed to get stats from node ${node.id}: ${error instanceof Error ? error.message : error}`,
        );
        this.addLoggedError(errorKey);
      }
      return null;
    }
  }

  async getNodeInfo(nodeId: string): Promise<Record<string, unknown>> {
    const client = await this.discoveryService.getNodeConnection(nodeId);
    const infoString = await client.info();
    return InfoParser.parse(infoString);
  }

  async getSlotMigrations(): Promise<SlotMigration[]> {
    const migrations: SlotMigration[] = [];

    try {
      // Use primary connection instead of individual node connections
      const client = this.discoveryService['dbClient'].getClient();
      const nodesString = (await client.call('CLUSTER', 'NODES')) as string;
      const lines = nodesString.trim().split('\n');

      // Get all discovered nodes for lookup
      const nodes = await this.discoveryService.discoverNodes();

      for (const line of lines) {
        const parts = line.split(' ');
        if (parts.length < 8) continue;

        const nodeId = parts[0];
        const address = parts[1];
        const slots = parts.slice(8);

        for (const slotRange of slots) {
          const migratingMatch = slotRange.match(/\[(\d+)->-([a-f0-9]+)\]/i);
          if (migratingMatch) {
            const slot = parseInt(migratingMatch[1], 10);
            const targetNodeId = migratingMatch[2];
            const targetNode = nodes.find((n) => n.id.startsWith(targetNodeId));

            if (targetNode) {
              migrations.push({
                slot,
                sourceNodeId: nodeId,
                sourceAddress: address,
                targetNodeId: targetNode.id,
                targetAddress: targetNode.address,
                state: 'migrating',
                keysRemaining: undefined, // Can't get this without node connection
              });
            }
          }

          const importingMatch = slotRange.match(/\[(\d+)-<-([a-f0-9]+)\]/i);
          if (importingMatch) {
            const slot = parseInt(importingMatch[1], 10);
            const sourceNodeId = importingMatch[2];
            const sourceNode = nodes.find((n) => n.id.startsWith(sourceNodeId));

            if (sourceNode) {
              migrations.push({
                slot,
                sourceNodeId: sourceNode.id,
                sourceAddress: sourceNode.address,
                targetNodeId: nodeId,
                targetAddress: address,
                state: 'importing',
              });
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to check slot migrations: ${error instanceof Error ? error.message : error}`,
      );
    }

    return migrations;
  }

  private async getKeysInSlot(client: Valkey, slot: number): Promise<number | undefined> {
    try {
      const keys = (await client.call('CLUSTER', 'GETKEYSINSLOT', slot, MAX_KEYS_TO_CHECK_IN_SLOT)) as string[];
      return keys.length;
    } catch (error) {
      this.logger.debug(
        `Could not get keys count for slot ${slot}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return undefined;
    }
  }

  private parseInfoValue(info: Record<string, unknown>, path: string, defaultValue?: number): number | undefined {
    const parts = path.split('.');
    let current: unknown = info;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return defaultValue;
      }
    }

    if (typeof current === 'string') {
      const parsed = parseFloat(current);
      return isNaN(parsed) ? defaultValue : parsed;
    }

    if (typeof current === 'number') {
      return current;
    }

    return defaultValue;
  }

  private getInfoString(info: Record<string, unknown>, path: string): string | undefined {
    const parts = path.split('.');
    let current: unknown = info;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return typeof current === 'string' ? current : undefined;
  }

  private getReplicationOffset(info: Record<string, unknown>, role: 'master' | 'replica'): number | undefined {
    if (role === 'master') {
      return this.parseInfoValue(info, 'replication.master_repl_offset');
    } else {
      return this.parseInfoValue(info, 'replication.slave_repl_offset');
    }
  }
}
