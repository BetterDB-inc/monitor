import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { dialsDataNodes } from '../connections/data-node-reach';
import { parseNodeAddress } from '../topology/membership-diff';
import { ClusterDiscoveryService, type DiscoveredNode } from './cluster-discovery.service';
import { collectionAmong } from './node-collection';

export interface ConnectedClusterNode {
  id: string;
  created: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

@Injectable()
export class ClusterNodeConnectService {
  private readonly nodeLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly clusterDiscovery: ClusterDiscoveryService,
  ) {}

  async connect(connectionId: string, nodeId: string): Promise<ConnectedClusterNode> {
    const source = this.sourceOf(connectionId);
    if (!dialsDataNodes(source)) {
      throw new BadRequestException(
        `${source.name} cannot open its own connection to a cluster node: it reads the cluster through an agent or from pushed metrics.`,
      );
    }
    return this.withNodeLock(nodeId, () =>
      this.connectionRegistry.withSeedLock(source.id, () => this.connectUnderLock(connectionId, source.id, nodeId)),
    );
  }

  private async withNodeLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.nodeLocks.get(nodeId) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.catch(() => undefined);
    this.nodeLocks.set(nodeId, tail);
    try {
      return await run;
    } finally {
      if (this.nodeLocks.get(nodeId) === tail) this.nodeLocks.delete(nodeId);
    }
  }

  private sourceOf(connectionId: string): DatabaseConnectionConfig {
    const config = this.connectionRegistry.getConfig(connectionId);
    if (!config) {
      throw new NotFoundException(`Connection '${connectionId}' not found.`);
    }
    const seed = config.membership ? this.connectionRegistry.getConfig(config.membership.seedId) : null;
    return seed ?? config;
  }

  private async connectUnderLock(connectionId: string, sourceId: string, nodeId: string): Promise<ConnectedClusterNode> {
    const nodes = await this.readNodes(connectionId);
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new NotFoundException(`Node '${nodeId}' is not in the cluster view of this connection.`);
    }
    const address = parseNodeAddress(node.address);
    if (!address) {
      throw new BadRequestException(`Node '${nodeId}' has no address in the cluster view yet.`);
    }
    const collection = collectionAmong(node, connectionId, this.connectionRegistry);
    if (collection.collected && collection.connectionId) {
      return { id: collection.connectionId, created: false };
    }
    const occupant = this.connectionRegistry.findIdByHostPort(address.host, address.port);
    if (occupant) {
      const name = this.connectionRegistry.getConfig(occupant)?.name ?? occupant;
      throw new ConflictException(
        `${address.host}:${address.port} is already registered as '${name}', which reads another node there. Remove that connection first.`,
      );
    }
    try {
      return { id: await this.connectionRegistry.addNodeConnection(sourceId, address), created: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(messageOf(error));
    }
  }

  private async readNodes(connectionId: string): Promise<DiscoveredNode[]> {
    try {
      return await this.clusterDiscovery.discoverNodes(connectionId);
    } catch (error) {
      throw new BadRequestException(`Could not read the cluster nodes of this connection: ${messageOf(error)}`);
    }
  }
}
