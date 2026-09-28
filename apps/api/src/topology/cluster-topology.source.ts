import { Injectable } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import type { DatabaseCapabilities } from '../common/interfaces/database-port.interface';
import { ClusterDiscoveryService } from '../cluster/cluster-discovery.service';
import { desiredFromDiscovery } from './membership-diff';
import type { TopologyDiscovery, TopologySource } from './topology-source';

@Injectable()
export class ClusterTopologySource implements TopologySource {
  readonly kind = 'cluster' as const;
  readonly envFlag = 'CLUSTER_AUTO_REGISTER_NODES';

  constructor(private readonly discovery: ClusterDiscoveryService) {}

  handles(caps: DatabaseCapabilities): boolean {
    return caps.clusterEnabled === true;
  }

  async discover(seed: DatabaseConnectionConfig, timeoutMs: number): Promise<TopologyDiscovery> {
    const nodes = await this.discovery.discoverNodesIsolated(seed.id, timeoutMs);
    return { nodes: desiredFromDiscovery(seed, nodes), unknownGroups: [] };
  }
}
