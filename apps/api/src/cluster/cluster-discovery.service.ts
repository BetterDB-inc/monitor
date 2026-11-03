import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Valkey from 'iovalkey';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { ClusterNode } from '../common/types/metrics.types';
import { MetricsParser } from '../database/parsers/metrics.parser';
import { tlsIdentityOptions } from '../database/adapters/tls-servername';

export interface DiscoveredNode {
  id: string;
  address: string; // host:port
  role: 'master' | 'replica';
  masterId?: string;
  slots: number[][];
  configEpoch: number;
  healthy: boolean;
  flags: string[];
  hostname?: string;
}

export interface NodeConnection {
  node: DiscoveredNode;
  client: Valkey;
  lastHealthCheck: number;
  healthy: boolean;
  connectionId?: string;
  host?: string;
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
    const cached = this.freshCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const client = this.connectionRegistry.get(connectionId);
      return this.remember(cacheKey, await client.getClusterNodes());
    } catch (error) {
      this.logger.error(
        `Failed to discover cluster nodes: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async discoverNodesIsolated(connectionId: string, timeoutMs: number): Promise<DiscoveredNode[]> {
    const cached = this.freshCache(connectionId);
    if (cached) {
      return cached;
    }

    const { host, port, username, password, tls } = this.connectionRegistry.get(connectionId).getClient().options;
    const client = new Valkey({
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
      connectionName: 'BetterDB-Monitor-Discovery',
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      const raw = await client.call('CLUSTER', 'NODES');
      return this.remember(connectionId, MetricsParser.parseClusterNodes(raw as string));
    } finally {
      client.disconnect();
    }
  }

  private freshCache(cacheKey: string): DiscoveredNode[] | null {
    const cached = this.discoveryCacheByConnection.get(cacheKey);
    if (
      cached &&
      cached.nodes.length > 0 &&
      Date.now() - cached.lastDiscoveryTime < this.DISCOVERY_CACHE_TTL
    ) {
      return cached.nodes;
    }
    return null;
  }

  private remember(cacheKey: string, clusterNodes: ClusterNode[]): DiscoveredNode[] {
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
        flags: node.flags,
        ...(node.hostname ? { hostname: node.hostname } : {}),
      });
    }

    // Store in per-connection cache
    this.discoveryCacheByConnection.set(cacheKey, {
      nodes: discovered,
      lastDiscoveryTime: Date.now(),
    });

    // A failed node lingers in CLUSTER NODES until it is forgotten; keep it out
    // of the role counts so a dead primary is not reported as a fourth master.
    const failed = discovered.filter((n) => !n.healthy).length;
    this.logger.log(
      `Discovered ${discovered.length} nodes for connection ${cacheKey} (${discovered.filter(n => n.healthy && n.role === 'master').length} masters, ${discovered.filter(n => n.healthy && n.role === 'replica').length} replicas${failed > 0 ? `, ${failed} failed` : ''})`,
    );

    return discovered;
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
        this.refreshNodeTls(existingConnection);
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
            await this.closeNodeClient(oldConnection.client);
            this.discoveredNodes.delete(oldestNodeId);
          }
        }
      }
    }

    // Bind the node client to the connection that owns it now, so a later
    // default-connection change can't swap in another connection's TLS identity.
    const ownerId = connectionId || this.connectionRegistry.getDefaultId() || undefined;
    const nodes = await this.discoverNodes(ownerId);
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

    const dbClient = this.connectionRegistry.get(ownerId);
    const primaryClient = dbClient.getClient();
    const username = primaryClient.options.username || '';
    const password = primaryClient.options.password || '';
    const tls = this.nodeTlsOptions(ownerId, host, node.hostname);

    const client = new Valkey({
      host,
      port,
      username,
      password,
      tls,
      lazyConnect: true,
      connectTimeout: this.CONNECTION_TIMEOUT,
      enableOfflineQueue: false,
      connectionName: `BetterDB-Monitor-Node-${node.id.substring(0, 8)}`,
    });

    // Node clients are long-lived, so pick up rotated client cert/key material
    // from the primary adapter before every reconnect.
    client.on('reconnecting', () => {
      this.refreshNodeTls({ node, client, connectionId: ownerId, host });
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
        connectionId: ownerId,
        host,
      };

      // Close any stale client we're about to replace so the overwrite never
      // orphans a still-open socket (belt-and-suspenders for the not-ready path
      // that falls through above).
      const replaced = this.discoveredNodes.get(nodeId);
      if (replaced && replaced.client !== client) {
        await this.closeNodeClient(replaced.client);
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

      await this.closeNodeClient(client);

      throw error;
    }
  }

  /**
   * TLS options for a discovered node, built from the primary adapter's current
   * material. getClient() re-reads file-sourced material when it has rotated.
   */
  private nodeTlsOptions(
    connectionId: string | undefined,
    host: string,
    hostname: string | undefined,
  ): Valkey['options']['tls'] {
    const primaryTls = this.connectionRegistry.get(connectionId).getClient().options.tls;
    if (!primaryTls) return undefined;
    const { servername: _servername, checkServerIdentity: _checkServerIdentity, ...nodeTls } = primaryTls;
    return { ...nodeTls, ...tlsIdentityOptions(host, hostname) };
  }

  private refreshNodeTls(connection: Pick<NodeConnection, 'node' | 'client' | 'connectionId' | 'host'>): void {
    if (!connection.host || !connection.client.options?.tls) return;
    try {
      connection.client.options.tls = this.nodeTlsOptions(
        connection.connectionId,
        connection.host,
        connection.node.hostname,
      );
    } catch (error) {
      this.logger.warn(
        `Keeping previous TLS material for node ${connection.node.id.substring(0, 12)}: ${error instanceof Error ? error.message : error}`,
      );
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

    await Promise.allSettled(
      Array.from(this.discoveredNodes.values(), (connection) => this.closeNodeClient(connection.client)),
    );
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
          await this.closeNodeClient(connection.client);
          this.discoveredNodes.delete(nodeId);
        }
      }
    }
  }

  /**
   * Node clients set enableOfflineQueue: false, so quit() on one that isn't
   * ready rejects without closing it and iovalkey keeps reconnecting (and
   * re-reading TLS) forever. Only quit a ready client; disconnect the rest.
   */
  private async closeNodeClient(client: Valkey): Promise<void> {
    if (client.status === 'ready') {
      await client.quit().catch(() => client.disconnect());
    } else {
      client.disconnect();
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
