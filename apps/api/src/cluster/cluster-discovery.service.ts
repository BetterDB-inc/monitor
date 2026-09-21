import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Valkey from 'iovalkey';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { ClusterNode } from '../common/types/metrics.types';
import {
  CLUSTER_CONNECTION_TIMEOUT_MS,
  CLUSTER_DISCOVERY_CACHE_TTL_MS,
  CLUSTER_HEALTH_CHECK_INTERVAL_MS,
  CLUSTER_HEALTH_CHECK_TIMEOUT_MS,
  CLUSTER_IDLE_TIMEOUT_MS,
} from '../common/constants/cluster.constants';

export interface DiscoveredNode {
  id: string;
  address: string; // host:port
  role: 'master' | 'replica';
  masterId?: string;
  slots: number[][];
  configEpoch: number;
  healthy: boolean;
}

export interface NodeConnection {
  node: DiscoveredNode;
  client: Valkey;
  lastHealthCheck: number;
  healthy: boolean;
  /** Registry connection id this node belongs to (for SSH forward eviction). */
  connectionId?: string;
  /** Advertised remote endpoint the SSH forward was opened for. */
  remoteHost?: string;
  remotePort?: number;
}

/** Parse an advertised `host:port[@busport]` endpoint. */
function parseAdvertisedEndpoint(address: string): { host: string; port: number } | null {
  const [host, portStr] = address.split('@')[0].split(':');
  const port = parseInt(portStr, 10);
  if (!host || isNaN(port)) return null;
  return { host, port };
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
  private readonly MAX_LOGGED_ERRORS = 1000;
  private readonly DISCOVERY_CACHE_TTL = CLUSTER_DISCOVERY_CACHE_TTL_MS;
  private readonly CONNECTION_TIMEOUT = CLUSTER_CONNECTION_TIMEOUT_MS;
  private readonly HEALTH_CHECK_INTERVAL = CLUSTER_HEALTH_CHECK_INTERVAL_MS;
  private readonly MAX_CONNECTIONS = 100;

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
          configEpoch: node.configEpoch,
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
      if (existingConnection.client.status === 'ready') {
        // Reuse the live client and refresh its check stamp. A ready connection
        // older than HEALTH_CHECK_INTERVAL must NOT fall through to the create
        // path below: that overwrites the map entry and orphans this still-open
        // socket (cleanupIdleConnections can't reach it once it's out of the map,
        // and MAX_CONNECTIONS never trips because the map size is unchanged),
        // leaking one ESTABLISHED connection to the monitored node per stale
        // reuse. Active liveness is validated separately by healthCheckNode.
        existingConnection.lastHealthCheck = Date.now();
        existingConnection.healthy = true;
        return existingConnection.client;
      }

      // Not ready — revive it in place before falling back to a brand-new client.
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
            this.releaseNodeForward(oldConnection);
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

    let dialHost = host;
    let dialPort = port;
    try {
      const tunnelled = await dbClient.dialNodeThroughTunnel?.(host, port);
      if (tunnelled) {
        dialHost = tunnelled.host;
        dialPort = tunnelled.port;
        if (dialHost !== host || dialPort !== port) {
          this.logger.log(`Dialling cluster node ${nodeId} at ${host}:${port} via SSH tunnel (${dialHost}:${dialPort})`);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Cannot open SSH node forward to ${host}:${port} for node ${nodeId.substring(0, 12)}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }

    const client = new Valkey({
      host: dialHost,
      port: dialPort,
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
        connectionId,
        remoteHost: host,
        remotePort: port,
      };

      // Quit any stale client we're about to replace so the overwrite never
      // orphans a still-open socket (belt-and-suspenders for the not-ready path
      // that falls through above).
      const replaced = this.discoveredNodes.get(nodeId);
      if (replaced && replaced.client !== client) {
        await replaced.client.quit().catch(() => {});
      }

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
          setTimeout(() => reject(new Error('Health check timeout')), CLUSTER_HEALTH_CHECK_TIMEOUT_MS),
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

  private releaseNodeForward(connection: NodeConnection): void {
    const remote = connection.remoteHost !== undefined && connection.remotePort !== undefined
      ? { host: connection.remoteHost, port: connection.remotePort }
      : connection.node?.address
        ? parseAdvertisedEndpoint(connection.node.address)
        : null;
    if (!remote) return;
    try {
      const dbClient = this.connectionRegistry.get(connection.connectionId);
      (dbClient as unknown as { releaseNodeThroughTunnel?: (h: string, p: number) => void })
        .releaseNodeThroughTunnel?.(remote.host, remote.port);
    } catch {
      // Registry lookup can throw for a removed connection; eviction is best-effort.
    }
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
    for (const connection of this.discoveredNodes.values()) {
      this.releaseNodeForward(connection);
    }
    this.discoveredNodes.clear();
    this.discoveryCacheByConnection.clear();
    this.logger.log('All node connections closed');
  }

  async cleanupIdleConnections(maxIdleTime: number = CLUSTER_IDLE_TIMEOUT_MS): Promise<void> {
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
          this.releaseNodeForward(connection);
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
