import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Valkey from 'iovalkey';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { ClusterNode } from '../common/types/metrics.types';

export interface DiscoveredNode {
  id: string;
  address: string; // host:port
  role: 'master' | 'replica';
  masterId?: string;
  slots: number[][];
  healthy: boolean;
}

export interface NodeConnection {
  node: DiscoveredNode;
  client: Valkey;
  lastHealthCheck: number;
  healthy: boolean;
}

export interface NodeHealth {
  nodeId: string;
  address: string;
  healthy: boolean;
  lastCheck: number;
  error?: string;
}

// Per-connection discovery cache
interface DiscoveryCache {
  nodes: DiscoveredNode[];
  lastDiscoveryTime: number;
}

@Injectable()
export class ClusterDiscoveryService implements OnModuleDestroy {
  private readonly logger = new Logger(ClusterDiscoveryService.name);
  private discoveredNodes: Map<string, NodeConnection> = new Map();
  // Per-connection discovery cache to prevent cross-connection cache contamination
  private discoveryCacheByConnection: Map<string, DiscoveryCache> = new Map();
  private loggedConnectionErrors: Set<string> = new Set();
  private loggedGetConnectionErrors: Set<string> = new Set();
  private readonly MAX_LOGGED_ERRORS = 1000; // Prevent unbounded growth
  private readonly DISCOVERY_CACHE_TTL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 5000; // 5 seconds
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
  private readonly MAX_CONNECTIONS = 100; // Maximum number of concurrent connections

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  async onModuleDestroy() {
    await this.disconnectAll();
  }

  async discoverNodes(connectionId?: string): Promise<DiscoveredNode[]> {
    // Use connection-specific cache key (default connection uses 'default')
    const cacheKey = connectionId || this.connectionRegistry.getDefaultId() || 'default';
    const cached = this.discoveryCacheByConnection.get(cacheKey);

    if (
      cached &&
      cached.nodes.length > 0 &&
      Date.now() - cached.lastDiscoveryTime < this.DISCOVERY_CACHE_TTL
    ) {
      return cached.nodes;
    }

    try {
      const client = this.connectionRegistry.get(connectionId);
      const clusterNodes: ClusterNode[] = await client.getClusterNodes();
      const discovered: DiscoveredNode[] = [];

      for (const node of clusterNodes) {
        const isHealthy =
          node.flags.includes('connected') ||
          (!node.flags.includes('disconnected') && !node.flags.includes('fail'));

        const isMaster = node.flags.includes('master');
        const isReplica = node.flags.includes('slave') || node.flags.includes('replica');

        if (!isMaster && !isReplica) {
          continue;
        }

        discovered.push({
          id: node.id,
          address: node.address,
          role: isMaster ? 'master' : 'replica',
          masterId: isMaster ? undefined : node.master,
          slots: node.slots,
          healthy: isHealthy,
        });
      }

      // Store in per-connection cache
      this.discoveryCacheByConnection.set(cacheKey, {
        nodes: discovered,
        lastDiscoveryTime: Date.now(),
      });

      this.logger.log(
        `Discovered ${discovered.length} nodes for connection ${cacheKey} (${discovered.filter(n => n.role === 'master').length} masters, ${discovered.filter(n => n.role === 'replica').length} replicas)`,
      );

      return discovered;
    } catch (error) {
      this.logger.error(
        `Failed to discover cluster nodes: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async getNodeConnection(nodeId: string, connectionId?: string): Promise<Valkey> {
    const existingConnection = this.discoveredNodes.get(nodeId);
    if (existingConnection) {
      if (
        existingConnection.client.status === 'ready' &&
        Date.now() - existingConnection.lastHealthCheck < this.HEALTH_CHECK_INTERVAL
      ) {
        return existingConnection.client;
      }

      if (existingConnection.client.status !== 'ready') {
        try {
          await existingConnection.client.connect();
          existingConnection.lastHealthCheck = Date.now();
          existingConnection.healthy = true;
          return existingConnection.client;
        } catch (error) {
          this.logger.warn(`Failed to reconnect to node ${nodeId}: ${error}`);
          existingConnection.healthy = false;
        }
      }
    }

    if (this.discoveredNodes.size >= this.MAX_CONNECTIONS) {
      this.logger.warn(
        `Connection limit reached (${this.MAX_CONNECTIONS}). Cleaning up idle connections...`,
      );
      await this.cleanupIdleConnections(this.HEALTH_CHECK_INTERVAL);

      if (this.discoveredNodes.size >= this.MAX_CONNECTIONS) {
        const oldestNodeId = this.findOldestConnection();
        if (oldestNodeId) {
          this.logger.warn(`Closing oldest connection to ${oldestNodeId} to make room for new connection`);
          const oldConnection = this.discoveredNodes.get(oldestNodeId);
          if (oldConnection) {
            await oldConnection.client.quit().catch(() => {/* ignore */});
            this.discoveredNodes.delete(oldestNodeId);
          }
        }
      }
    }

    const nodes = await this.discoverNodes(connectionId);
    const node = nodes.find((n) => n.id === nodeId);

    if (!node) {
      throw new Error(`Node ${nodeId} not found in cluster`);
    }

    // Cluster node addresses include bus port: "host:port@busport"
    // We only need the client port, so split on '@' first
    const [host, portStr] = node.address.split('@')[0].split(':');
    const port = parseInt(portStr, 10);

    if (!host || isNaN(port)) {
      throw new Error(`Invalid node address: ${node.address}`);
    }

    const dbClient = this.connectionRegistry.get(connectionId);
    const primaryClient = dbClient.getClient();
    const username = primaryClient.options.username || '';
    const password = primaryClient.options.password || '';

    const client = new Valkey({
      host,
      port,
      username,
      password,
      lazyConnect: true,
      connectTimeout: this.CONNECTION_TIMEOUT,
      enableOfflineQueue: false,
      connectionName: `BetterDB-Monitor-Node-${node.id.substring(0, 8)}`,
    });

    // Add error handler to prevent unhandled error events
    // Only log each unique connection error once to avoid log spam
    client.on('error', (err) => {
      const errorCode = (err as any).code || err.name;
      const errorKey = `${nodeId}-${host}:${port}-${errorCode}`;
      if (!this.loggedConnectionErrors.has(errorKey)) {
        this.logger.warn(
          `Cannot connect to node ${nodeId.substring(0, 12)} at ${host}:${port}: ${err.message}`,
        );
        // Prevent unbounded growth
        if (this.loggedConnectionErrors.size >= this.MAX_LOGGED_ERRORS) {
          this.loggedConnectionErrors.clear();
        }
        this.loggedConnectionErrors.add(errorKey);
      }
    });

    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), this.CONNECTION_TIMEOUT),
        ),
      ]);

      const connection: NodeConnection = {
        node,
        client,
        lastHealthCheck: Date.now(),
        healthy: true,
      };

      this.discoveredNodes.set(nodeId, connection);
      this.logger.log(`Connected to node ${nodeId} at ${host}:${port}`);

      // Clear logged errors for this node on successful connection
      this.clearNodeErrors(nodeId);

      return client;
    } catch (error) {
      // Only log each unique connection error once to avoid spam
      const errorKey = `connect-${nodeId}`;
      if (!this.loggedGetConnectionErrors.has(errorKey)) {
        this.logger.debug(
          `Failed to connect to node ${nodeId} at ${host}:${port}: ${error instanceof Error ? error.message : error}`,
        );
        // Prevent unbounded growth
        if (this.loggedGetConnectionErrors.size >= this.MAX_LOGGED_ERRORS) {
          this.loggedGetConnectionErrors.clear();
        }
        this.loggedGetConnectionErrors.add(errorKey);
      }

      await client.quit().catch(() => {});

      throw error;
    }
  }

  private clearNodeErrors(nodeId: string): void {
    // Remove all logged errors for this node
    for (const key of this.loggedConnectionErrors) {
      if (key.startsWith(nodeId)) {
        this.loggedConnectionErrors.delete(key);
      }
    }
    this.loggedGetConnectionErrors.delete(`connect-${nodeId}`);
  }

  async healthCheckAll(): Promise<NodeHealth[]> {
    const nodes = await this.discoverNodes();
    const healthChecks: Promise<NodeHealth>[] = [];

    for (const node of nodes) {
      healthChecks.push(this.healthCheckNode(node));
    }

    return Promise.all(healthChecks);
  }

  private async healthCheckNode(node: DiscoveredNode): Promise<NodeHealth> {
    try {
      const client = await this.getNodeConnection(node.id);
      const result = await Promise.race([
        client.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Health check timeout')), 2000),
        ),
      ]);

      const healthy = result === 'PONG';

      const connection = this.discoveredNodes.get(node.id);
      if (connection) {
        connection.healthy = healthy;
        connection.lastHealthCheck = Date.now();
      }

      return {
        nodeId: node.id,
        address: node.address,
        healthy,
        lastCheck: Date.now(),
      };
    } catch (error) {
      const connection = this.discoveredNodes.get(node.id);
      if (connection) {
        connection.healthy = false;
        connection.lastHealthCheck = Date.now();
      }

      return {
        nodeId: node.id,
        address: node.address,
        healthy: false,
        lastCheck: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getActiveConnections(): NodeConnection[] {
    return Array.from(this.discoveredNodes.values());
  }

  async disconnectAll(): Promise<void> {
    this.logger.log(`Disconnecting from ${this.discoveredNodes.size} nodes`);

    const disconnectPromises: Promise<void>[] = [];

    for (const [nodeId, connection] of this.discoveredNodes.entries()) {
      disconnectPromises.push(
        connection.client.quit().then(() => undefined).catch((error) => {
          this.logger.warn(
            `Failed to disconnect from node ${nodeId}: ${error instanceof Error ? error.message : error}`,
          );
        }),
      );
    }

    await Promise.allSettled(disconnectPromises);
    this.discoveredNodes.clear();
    this.discoveryCacheByConnection.clear();
    this.logger.log('All node connections closed');
  }

  async cleanupIdleConnections(maxIdleTime: number = 60000): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [nodeId, connection] of this.discoveredNodes.entries()) {
      if (now - connection.lastHealthCheck > maxIdleTime) {
        toRemove.push(nodeId);
      }
    }

    if (toRemove.length > 0) {
      this.logger.log(`Cleaning up ${toRemove.length} idle connections`);

      for (const nodeId of toRemove) {
        const connection = this.discoveredNodes.get(nodeId);
        if (connection) {
          await connection.client.quit().catch(() => {});
          this.discoveredNodes.delete(nodeId);
        }
      }
    }
  }

  private findOldestConnection(): string | null {
    let oldestNodeId: string | null = null;
    let oldestTime = Number.MAX_SAFE_INTEGER;

    for (const [nodeId, connection] of this.discoveredNodes.entries()) {
      if (connection.lastHealthCheck < oldestTime) {
        oldestTime = connection.lastHealthCheck;
        oldestNodeId = nodeId;
      }
    }

    return oldestNodeId;
  }

  getConnectionPoolSize(): number {
    return this.discoveredNodes.size;
  }
}
