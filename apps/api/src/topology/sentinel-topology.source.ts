import { Injectable } from '@nestjs/common';
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
      const reply = await client.call('SENTINEL', 'MASTERS');
      if (!Array.isArray(reply)) return null;
      const masters = MetricsParser.parseSentinelNodes(reply);
      if (masters.length === 0 && reply.length > 0) return null;
      const nodes: DesiredNode[] = [];
      const unknownGroups: string[] = [];
      for (const master of masters) {
        nodes.push(this.toNode(master.name, master.ip, master.port, master.runid, 'primary'));
        try {
          const replicas = MetricsParser.parseSentinelNodes(
            (await client.call('SENTINEL', 'REPLICAS', master.name)) as unknown[],
          );
          for (const replica of replicas) {
            nodes.push(this.toNode(master.name, replica.ip, replica.port, replica.runid, 'replica'));
          }
        } catch {
          unknownGroups.push(master.name);
        }
      }
      return { nodes, unknownGroups };
    } finally {
      client.disconnect();
    }
  }

  private toNode(group: string, host: string, port: number, runid: string, role: 'primary' | 'replica'): DesiredNode {
    return { host, port, nodeId: runid || `${group}/${host}:${port}`, source: 'sentinel', group, role };
  }
}
