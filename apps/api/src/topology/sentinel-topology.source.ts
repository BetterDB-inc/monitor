import { Injectable, Logger } from '@nestjs/common';
import Valkey, { RedisOptions as ValkeyOptions } from 'iovalkey';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import type { DatabaseCapabilities } from '../common/interfaces/database-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { MetricsParser } from '../database/parsers/metrics.parser';
import type { DesiredNode } from './membership-diff';
import type { TopologyDiscovery, TopologySource } from './topology-source';

export type SentinelClient = Pick<Valkey, 'connect' | 'call' | 'disconnect' | 'on'>;
export type SentinelClientFactory = (options: ValkeyOptions) => SentinelClient;

const defaultFactory: SentinelClientFactory = (options) => new Valkey(options);

@Injectable()
export class SentinelTopologySource implements TopologySource {
  readonly kind = 'sentinel' as const;
  readonly envFlag = 'SENTINEL_AUTO_REGISTER_NODES';
  private readonly logger = new Logger(SentinelTopologySource.name);

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly clientFactory: SentinelClientFactory = defaultFactory,
  ) {}

  handles(caps: DatabaseCapabilities): boolean {
    return caps.isSentinel === true;
  }

  async discover(seed: DatabaseConnectionConfig, timeoutMs: number): Promise<TopologyDiscovery | null> {
    const { host, port, username, password, tls } = this.connectionRegistry.get(seed.id).getClient().options;
    const client = this.clientFactory({
      host,
      port,
      username,
      password,
      tls,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableReadyCheck: false,
      connectTimeout: timeoutMs,
      commandTimeout: timeoutMs,
      connectionName: 'BetterDB-Monitor-Sentinel-Discovery',
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      const reported = this.parseNodes(await client.call('SENTINEL', 'MASTERS'));
      if (reported === null) return null;
      const masters = reported.filter((master) => master.name);
      if (masters.length < reported.length) {
        this.logger.warn(`Ignoring ${reported.length - masters.length} SENTINEL MASTERS entries without a name reported by ${seed.name}`);
      }
      const nodes: DesiredNode[] = [];
      const unknownGroups: string[] = [];
      for (const master of masters) {
        nodes.push(this.toNode(master.name, master.ip, master.port, master.runid, 'primary'));
        try {
          const replicas = this.parseNodes(await client.call('SENTINEL', 'REPLICAS', master.name));
          if (replicas === null) {
            unknownGroups.push(master.name);
            continue;
          }
          for (const replica of replicas) {
            nodes.push(this.toNode(master.name, replica.ip, replica.port, replica.runid, 'replica'));
          }
        } catch {
          unknownGroups.push(master.name);
        }
      }
      return { nodes, unknownGroups: [...new Set([...unknownGroups, ...this.groupsWithDuplicateAddresses(nodes)])] };
    } finally {
      client.disconnect();
    }
  }

  private parseNodes(reply: unknown): ReturnType<typeof MetricsParser.parseSentinelNodes> | null {
    if (!Array.isArray(reply)) return null;
    const parsed = MetricsParser.parseSentinelNodes(reply);
    return parsed.length === 0 && reply.length > 0 ? null : parsed;
  }

  private groupsWithDuplicateAddresses(nodes: DesiredNode[]): string[] {
    const groupsByAddress = new Map<string, DesiredNode[]>();
    for (const node of nodes) {
      const address = `${node.host.toLowerCase()}:${node.port}`;
      groupsByAddress.set(address, [...(groupsByAddress.get(address) ?? []), node]);
    }
    return [...groupsByAddress.values()]
      .filter((shared) => shared.length > 1)
      .flatMap((shared) => shared.flatMap((node) => (node.group ? [node.group] : [])));
  }

  private toNode(group: string, host: string, port: number, runid: string, role: 'primary' | 'replica'): DesiredNode {
    return { host, port, nodeId: runid || `${group}/${host}:${port}`, source: 'sentinel', group, role };
  }
}
