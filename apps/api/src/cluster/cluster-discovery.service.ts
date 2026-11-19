import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import Valkey, { type RedisOptions as ValkeyOptions } from 'iovalkey';
import { clusterNodeState, type ClusterNodeState } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { dialsDataNodes } from '../connections/data-node-reach';
import { ClusterNode } from '../common/types/metrics.types';
import { MetricsParser } from '../database/parsers/metrics.parser';
import { tlsIdentityOptions } from '../database/adapters/tls-servername';
import { parseNodeAddress } from '../topology/membership-diff';
import { collectionAmong, type NodeCollection } from './node-collection';
import { readClusterShards, withConfiguredZones, withShardMetadata } from './shard-metadata';

export interface DiscoveredNode {
  id: string;
  address: string; // host:port
  role: 'master' | 'replica';
  masterId?: string;
  slots: number[][];
  configEpoch: number;
  state: ClusterNodeState;
  flags: string[];
  hostname?: string;
  availabilityZone?: string;
  shardId?: string;
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

interface OwnNodeClient {
  shared: Valkey;
  host: string | undefined;
  port: number | undefined;
  username: string | undefined;
  password: string | undefined;
  tls: Valkey['options']['tls'];
  client: Valkey;
  ready: Promise<void>;
  connected: boolean;
  running: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

// Per-connection discovery cache
interface DiscoveryCache {
  nodes: DiscoveredNode[];
  lastDiscoveryTime: number;
}

const DEFAULT_NODE_COMMAND_TIMEOUT_MS = 5000;
const MIN_NODE_COMMAND_TIMEOUT_MS = 100;
const MAX_NODE_COMMAND_TIMEOUT_MS = 2_147_483_647;

function nodeCommandTimeoutMs(): number {
  const configured = Number(process.env.CLUSTER_NODE_COMMAND_TIMEOUT_MS);
  return Number.isInteger(configured) &&
    configured >= MIN_NODE_COMMAND_TIMEOUT_MS &&
    configured <= MAX_NODE_COMMAND_TIMEOUT_MS
    ? configured
    : DEFAULT_NODE_COMMAND_TIMEOUT_MS;
}

const UNRESPONSIVE_NODE_COOL_OFF_MS = 30_000;
const MAX_UNRESPONSIVE_NODES = 512;
const COMMAND_TIMED_OUT = 'Command timed out';
const CONNECTION_TIMED_OUT = 'Connection timeout';

function isConnectTimeout(error: unknown): boolean {
  return error instanceof Error && (error.message === CONNECTION_TIMED_OUT || error.message.includes('ETIMEDOUT'));
}

type NodeCommandOutcome = 'answered' | 'timedOut';

interface OpeningNodeClient {
  ownerId: string | undefined;
  released: boolean;
}

function assertNotReleased(opening: OpeningNodeClient, address: string): void {
  if (opening.released) {
    throw new Error(`Connection to ${address} was released while it was opening`);
  }
}

class NodeClient extends Valkey {
  private readonly report: (outcome: NodeCommandOutcome) => void;

  constructor(options: ValkeyOptions, report: (outcome: NodeCommandOutcome) => void) {
    super(options);
    this.report = report;
  }

  sendCommand(...args: Parameters<Valkey['sendCommand']>): ReturnType<Valkey['sendCommand']> {
    args[0].promise.then(
      () => this.report('answered'),
      (error: unknown) => {
        if (error instanceof Error && error.message === COMMAND_TIMED_OUT) this.report('timedOut');
      },
    );
    return super.sendCommand(...args);
  }
}

@Injectable()
export class ClusterDiscoveryService implements OnModuleDestroy {
  private readonly logger = new Logger(ClusterDiscoveryService.name);
  private discoveredNodes: Map<string, NodeConnection> = new Map();
  // Per-connection discovery cache to prevent cross-connection cache contamination
  private discoveryCacheByConnection: Map<string, DiscoveryCache> = new Map();
  private discoveryInFlight: Map<string, Promise<DiscoveredNode[]>> = new Map();
  private ownNodeClients: Map<string, OwnNodeClient> = new Map();
  private loggedConnectionErrors: Set<string> = new Set();
  private loggedGetConnectionErrors: Set<string> = new Set();
  private readonly MAX_LOGGED_ERRORS = 1000; // Prevent unbounded growth
  private readonly DISCOVERY_CACHE_TTL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 5000; // 5 seconds
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
  private readonly MAX_CONNECTIONS = 512; // Maximum number of concurrent connections
  private readonly OWN_NODE_IDLE_MS = 5 * 60_000;
  private readonly POOL_LIMIT_WARN_INTERVAL_MS = 60_000;
  private pendingNodeClients = 0;
  private openingNodeClients = new Set<OpeningNodeClient>();
  private poolLimitWarnedAt = 0;
  private poolLimitClosedSinceWarning = 0;
  private unresponsiveUntil: Map<string, number> = new Map();

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  async onModuleDestroy() {
    await this.disconnectAll();
  }

  async discoverNodes(connectionId?: string): Promise<DiscoveredNode[]> {
    const ownerId = connectionId || this.connectionRegistry.getDefaultId();
    if (!ownerId) {
      throw new NotFoundException('No connection available');
    }
    const cacheKey = ownerId;
    const cached = this.freshCache(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = this.discoveryInFlight.get(cacheKey);
    if (pending) return pending;

    const discovery: Promise<DiscoveredNode[]> = Promise.resolve().then(async () => {
      try {
        const client = this.connectionRegistry.get(ownerId);
        const [clusterNodes, shards] = await Promise.all([client.getClusterNodes(), readClusterShards(client)]);
        const nodes = withConfiguredZones(
          withShardMetadata(clusterNodes, shards),
          this.connectionRegistry.getNodeAvailabilityZones(ownerId),
        );
        if (this.discoveryInFlight.get(cacheKey) !== discovery) return this.toDiscoveredNodes(nodes);
        return this.remember(cacheKey, nodes);
      } catch (error) {
        this.logger.error(
          `Failed to discover cluster nodes: ${error instanceof Error ? error.message : error}`,
        );
        throw error;
      } finally {
        if (this.discoveryInFlight.get(cacheKey) === discovery) this.discoveryInFlight.delete(cacheKey);
      }
    });
    this.discoveryInFlight.set(cacheKey, discovery);
    return discovery;
  }

  async discoverNodesWithCollection(connectionId?: string): Promise<Array<DiscoveredNode & NodeCollection>> {
    const viewerId = connectionId || this.connectionRegistry.getDefaultId();
    const nodes = await this.discoverNodes(viewerId ?? undefined);
    return nodes.map((node) => ({ ...node, ...collectionAmong(node, viewerId, this.connectionRegistry) }));
  }

  /**
   * CLUSTER NODES over a socket of its own, opened for this call. Never served
   * from or written to the discovery cache: the cache holds the main socket's
   * view, while a seed behind a VIP lands each new socket on an arbitrary
   * node, and topology sync relies on seeing which node that was.
   */
  async discoverNodesIsolated(connectionId: string, timeoutMs: number): Promise<DiscoveredNode[]> {
    return this.onIsolatedClient(connectionId, timeoutMs, async (client) => {
      const raw = await client.call('CLUSTER', 'NODES');
      return this.toDiscoveredNodes(MetricsParser.parseClusterNodes(raw as string));
    });
  }

  async onIsolatedClient<T>(
    connectionId: string | undefined,
    timeoutMs: number,
    run: (client: Valkey) => Promise<T>,
  ): Promise<T> {
    const shared = this.connectionRegistry.get(connectionId).getClient();
    const client = new Valkey({
      ...this.seedClientOptions(shared, 'BetterDB-Monitor-Discovery'),
      ...this.oneShotOptions(timeoutMs),
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      return await run(client);
    } finally {
      client.disconnect();
    }
  }

  async onNodeClientOnce<T>(
    node: DiscoveredNode,
    connectionId: string | undefined,
    timeoutMs: number,
    run: (client: Valkey) => Promise<T>,
  ): Promise<T> {
    const ownerId = connectionId || this.connectionRegistry.getDefaultId() || undefined;
    this.assertDialsDataNodes(ownerId, node.id);
    const parsed = parseNodeAddress(node.address);
    if (!parsed) throw new Error(`Invalid node address: ${node.address}`);
    const client = new Valkey({
      ...this.nodeClientOptions(ownerId, node, parsed.host, parsed.port),
      ...this.oneShotOptions(timeoutMs),
    });
    let refused: Error | undefined;
    client.on('error', (err: Error) => {
      refused ??= err;
    });
    try {
      await client.connect().catch((err: unknown) => {
        throw refused ?? err;
      });
      return await run(client);
    } finally {
      client.disconnect();
    }
  }

  private seedClientOptions(shared: Valkey, connectionName: string): ValkeyOptions {
    const { host, port, username, password, tls } = shared.options;
    return { host, port, username, password, tls, lazyConnect: true, enableOfflineQueue: false, connectionName };
  }

  private nodeClientOptions(
    ownerId: string | undefined,
    node: DiscoveredNode,
    host: string,
    port: number,
    credentials?: { username: string; password: string },
  ): ValkeyOptions {
    const { username, password } =
      credentials ?? this.connectionRegistry.get(ownerId).getClient().options;
    return {
      host,
      port,
      username: username || '',
      password: password || '',
      tls: this.nodeTlsOptions(ownerId, host, node.hostname),
      lazyConnect: true,
      enableOfflineQueue: false,
      connectionName: `BetterDB-Monitor-Node-${node.id.substring(0, 8)}`,
    };
  }

  private oneShotOptions(timeoutMs: number): ValkeyOptions {
    return {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableReadyCheck: false,
      connectTimeout: timeoutMs,
      commandTimeout: timeoutMs,
    };
  }

  async onOwnNodeClient<T>(
    connectionId: string | undefined,
    timeoutMs: number,
    run: (client: Valkey) => Promise<T>,
  ): Promise<T> {
    const key = this.ownNodeKey(connectionId);
    const shared = this.connectionRegistry.get(connectionId).getClient();
    const { host, port, username, password, tls } = shared.options;
    const kept = this.ownNodeClients.get(key);
    const reusable =
      kept !== undefined &&
      kept.shared === shared &&
      kept.host === host &&
      kept.port === port &&
      kept.username === username &&
      kept.password === password &&
      kept.tls === tls &&
      (!kept.connected || kept.client.status === 'ready');
    if (kept && !reusable) this.dropOwnNodeClient(key, kept);
    const own = reusable ? kept : this.openOwnNodeClient(key, shared, timeoutMs);
    clearTimeout(own.idleTimer);
    own.running += 1;
    try {
      await own.ready;
      return await run(own.client);
    } catch (error) {
      this.dropOwnNodeClient(key, own);
      throw error;
    } finally {
      own.running -= 1;
      if (own.running === 0 && this.ownNodeClients.get(key) === own) this.closeWhenIdle(key, own);
    }
  }

  private closeWhenIdle(key: string, own: OwnNodeClient): void {
    own.idleTimer = setTimeout(() => {
      if (own.running === 0) this.dropOwnNodeClient(key, own);
    }, this.OWN_NODE_IDLE_MS);
    own.idleTimer.unref?.();
  }

  releaseOwnNodeClient(connectionId: string | undefined): void {
    const key = this.ownNodeKey(connectionId);
    const kept = this.ownNodeClients.get(key);
    if (kept) this.dropOwnNodeClient(key, kept);
  }

  private ownNodeKey(connectionId: string | undefined): string {
    return connectionId || this.connectionRegistry.getDefaultId() || 'default';
  }

  private openOwnNodeClient(key: string, shared: Valkey, timeoutMs: number): OwnNodeClient {
    const { host, port, username, password, tls } = shared.options;
    const client = new Valkey({
      ...this.seedClientOptions(shared, 'BetterDB-Monitor-Own-Node'),
      ...this.oneShotOptions(timeoutMs),
    });
    client.on('error', () => undefined);
    const own: OwnNodeClient = {
      shared,
      host,
      port,
      username,
      password,
      tls,
      client,
      ready: Promise.resolve(),
      connected: false,
      running: 0,
    };
    own.ready = client.connect().then(() => {
      own.connected = true;
    });
    this.ownNodeClients.set(key, own);
    return own;
  }

  private dropOwnNodeClient(key: string, own: OwnNodeClient): void {
    clearTimeout(own.idleTimer);
    if (this.ownNodeClients.get(key) === own) this.ownNodeClients.delete(key);
    own.client.disconnect();
  }

  forgetTopology(connectionId?: string): void {
    const cacheKey = connectionId || this.connectionRegistry.getDefaultId() || 'default';
    this.discoveryCacheByConnection.delete(cacheKey);
    this.discoveryInFlight.delete(cacheKey);
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
    const discovered = this.toDiscoveredNodes(clusterNodes);

    // Store in per-connection cache
    this.discoveryCacheByConnection.set(cacheKey, {
      nodes: discovered,
      lastDiscoveryTime: Date.now(),
    });

    // A failed node lingers in CLUSTER NODES until it is forgotten; keep it out
    // of the role counts so a dead primary is not reported as a fourth master.
    const live = discovered.filter((n) => n.state !== 'failed');
    const failed = discovered.length - live.length;
    const suspect = live.filter((n) => n.state === 'suspect').length;
    this.logger.log(
      `Discovered ${discovered.length} nodes for connection ${cacheKey} (${live.filter(n => n.role === 'master').length} masters, ${live.filter(n => n.role === 'replica').length} replicas${suspect > 0 ? `, ${suspect} suspect` : ''}${failed > 0 ? `, ${failed} failed` : ''})`,
    );

    return discovered;
  }

  private toDiscoveredNodes(clusterNodes: ClusterNode[]): DiscoveredNode[] {
    const discovered: DiscoveredNode[] = [];

    for (const node of clusterNodes) {
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
        // The link state is the answering node's own cluster-bus link to this
        // one, not whether Monitor can reach it, so only the flags count.
        state: clusterNodeState(node.flags),
        flags: node.flags,
        ...(node.hostname ? { hostname: node.hostname } : {}),
        ...(node.availabilityZone ? { availabilityZone: node.availabilityZone } : {}),
        ...(node.shardId ? { shardId: node.shardId } : {}),
      });
    }
    return discovered;
  }

  async getNodeConnection(nodeId: string, connectionId?: string): Promise<Valkey> {
    // Bind the node client to the connection that owns it now, so a later
    // default-connection change can't swap in another connection's TLS identity.
    const ownerId = connectionId || this.connectionRegistry.getDefaultId() || undefined;
    this.assertDialsDataNodes(ownerId, nodeId);
    const nodes = await this.discoverNodes(ownerId);
    const node = nodes.find((n) => n.id === nodeId);

    if (!node) {
      throw new Error(`Node ${nodeId} not found in cluster`);
    }

    const key = this.nodeClientKey(nodeId, ownerId);
    const existing = this.discoveredNodes.get(key);
    if (existing && existing.node.address.split('@')[0] !== node.address.split('@')[0]) {
      this.discoveredNodes.delete(key);
      existing.client.disconnect();
    }

    // Cluster node addresses include bus port: "host:port@busport", and an
    // IPv6 host has colons of its own, so the port is after the last one.
    const parsed = parseNodeAddress(node.address);
    const open = (): Promise<Valkey> => {
      if (!parsed) {
        throw new Error(`Invalid node address: ${node.address}`);
      }
      const primaryClient = this.connectionRegistry.get(ownerId).getClient();
      return this.openNodeClient(key, node, parsed.host, parsed.port, ownerId, {
        username: primaryClient.options.username || '',
        password: primaryClient.options.password || '',
      });
    };
    if (parsed) this.assertNodeAnswers(parsed.host, parsed.port, open);
    const reused = await this.reuseNodeClient(key);
    if (reused) return reused;
    return open();
  }

  /**
   * Refuses node clients for a connection whose nodes the monitor cannot dial
   * itself (an agent connection), rather than failing later on the seed's raw
   * client and reading as an unreachable node.
   */
  private assertDialsDataNodes(connectionId: string | undefined, node: string): void {
    if (connectionId && !dialsDataNodes(this.connectionRegistry.getConfig(connectionId))) {
      throw new Error(`Connection ${connectionId} cannot dial ${node} directly`);
    }
  }

  async getAddressConnection(host: string, port: number, connectionId: string): Promise<Valkey> {
    this.assertDialsDataNodes(connectionId, `${host}:${port}`);
    const credentials = this.connectionRegistry.sentinelDataNodeCredentials(connectionId);
    if (!credentials) {
      throw new Error(`Connection ${connectionId} has no data-node credentials for ${host}:${port}`);
    }
    const key = `addr:${connectionId}:${host}:${port}`;
    const node: DiscoveredNode = {
      id: key,
      address: `${host}:${port}`,
      role: 'master',
      slots: [],
      configEpoch: 0,
      state: 'healthy',
      flags: [],
    };
    const open = (): Promise<Valkey> =>
      this.openNodeClient(key, node, host, port, connectionId, {
        username: credentials.username ?? '',
        password: credentials.password ?? '',
      });
    this.assertNodeAnswers(host, port, open);
    const reused = await this.reuseNodeClient(key);
    if (reused) return reused;
    return open();
  }

  async getReplicaConnection(host: string, port: number, connectionId: string, hostname?: string): Promise<Valkey> {
    this.assertDialsDataNodes(connectionId, `${host}:${port}`);
    const config = this.connectionRegistry.getConfig(connectionId);
    if (!config || config.membership || config.sshTunnel?.enabled) {
      throw new Error(`Connection ${connectionId} cannot dial its replica ${host}:${port} directly`);
    }
    const key = `replica:${connectionId}:${host}:${port}`;
    const node: DiscoveredNode = {
      id: key,
      address: `${host}:${port}`,
      role: 'replica',
      slots: [],
      configEpoch: 0,
      state: 'healthy',
      flags: [],
      hostname,
    };
    const open = (): Promise<Valkey> => {
      const { username, password } = this.connectionRegistry.get(connectionId).getClient().options;
      return this.openNodeClient(key, node, host, port, connectionId, {
        username: username || '',
        password: password || '',
      });
    };
    this.assertNodeAnswers(host, port, open);
    const reused = await this.reuseNodeClient(key);
    if (reused) return reused;
    return open();
  }

  private assertNodeAnswers(host: string, port: number, open: () => Promise<Valkey>): void {
    const address = `${host}:${port}`;
    let until = this.unresponsiveUntil.get(address);
    if (until === undefined) return;
    const now = Date.now();
    if (now >= until) {
      const retryAt = now + UNRESPONSIVE_NODE_COOL_OFF_MS;
      until = retryAt;
      this.unresponsiveUntil.set(address, retryAt);
      void Promise.resolve()
        .then(open)
        .catch(() => {
          if (this.unresponsiveUntil.get(address) === retryAt) this.unresponsiveUntil.delete(address);
        });
    }
    throw new Error(`Node ${address} is not answering; next try in ${Math.ceil((until - now) / 1000)}s`);
  }

  private markNodeUnresponsive(address: string, client?: Valkey): void {
    if (!this.unresponsiveUntil.has(address)) {
      this.logger.warn(
        `Node ${address} is not answering; skipping it and trying again every ${UNRESPONSIVE_NODE_COOL_OFF_MS / 1000}s`,
      );
    }
    this.unresponsiveUntil.set(address, Date.now() + UNRESPONSIVE_NODE_COOL_OFF_MS);
    if (this.unresponsiveUntil.size > MAX_UNRESPONSIVE_NODES) {
      const [oldest] = [...this.unresponsiveUntil].reduce((first, next) => (next[1] < first[1] ? next : first));
      this.unresponsiveUntil.delete(oldest);
    }
    if (client) this.evictNodeClient(client);
  }

  private markNodeAnswering(address: string): void {
    if (this.unresponsiveUntil.delete(address)) {
      this.logger.log(`Node ${address} answers again`);
    }
  }

  private async reuseNodeClient(key: string): Promise<Valkey | null> {
    const existingConnection = this.discoveredNodes.get(key);
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
        this.logger.warn(`Failed to reconnect to node ${key}: ${error}`);
        existingConnection.healthy = false;
      }
    }

    return null;
  }

  private async reserveNodeClientSlot(): Promise<void> {
    let cleanedUp = false;
    while (this.discoveredNodes.size + this.pendingNodeClients >= this.MAX_CONNECTIONS) {
      if (!cleanedUp) {
        cleanedUp = true;
        this.warnAboutPoolLimit();
        await this.cleanupIdleConnections(this.HEALTH_CHECK_INTERVAL);
        continue;
      }
      const oldestNodeId = this.findOldestConnection(Date.now() - nodeCommandTimeoutMs());
      const oldest = oldestNodeId ? this.discoveredNodes.get(oldestNodeId) : undefined;
      if (!oldestNodeId || !oldest) break;
      this.logger.debug(`Closing oldest connection to ${oldestNodeId} to make room for new connection`);
      this.poolLimitClosedSinceWarning += 1;
      this.discoveredNodes.delete(oldestNodeId);
      void this.closeNodeClient(oldest.client).catch(() => undefined);
    }
    this.pendingNodeClients += 1;
  }

  private warnAboutPoolLimit(): void {
    const now = Date.now();
    if (now - this.poolLimitWarnedAt < this.POOL_LIMIT_WARN_INTERVAL_MS) return;
    const closed = this.poolLimitClosedSinceWarning;
    this.poolLimitWarnedAt = now;
    this.poolLimitClosedSinceWarning = 0;
    this.logger.warn(
      `Connection limit reached (${this.MAX_CONNECTIONS}). Closing idle and oldest node connections to make room` +
        (closed > 0 ? `; ${closed} closed since the last warning` : ''),
    );
  }

  private releaseNodeClientSlot(): void {
    this.pendingNodeClients -= 1;
  }

  private async openNodeClient(
    key: string,
    node: DiscoveredNode,
    host: string,
    port: number,
    ownerId: string | undefined,
    credentials: { username: string; password: string },
  ): Promise<Valkey> {
    const opening: OpeningNodeClient = { ownerId, released: false };
    this.openingNodeClients.add(opening);
    try {
      await this.reserveNodeClientSlot();
      try {
        return await this.connectNodeClient(key, node, host, port, opening, credentials);
      } finally {
        this.releaseNodeClientSlot();
      }
    } finally {
      this.openingNodeClients.delete(opening);
    }
  }

  private async connectNodeClient(
    key: string,
    node: DiscoveredNode,
    host: string,
    port: number,
    opening: OpeningNodeClient,
    { username, password }: { username: string; password: string },
  ): Promise<Valkey> {
    const { ownerId } = opening;
    const address = `${host}:${port}`;
    const client: Valkey = new NodeClient(
      {
        ...this.nodeClientOptions(ownerId, node, host, port, { username, password }),
        connectTimeout: this.CONNECTION_TIMEOUT,
        commandTimeout: nodeCommandTimeoutMs(),
        enableReadyCheck: true,
      },
      (outcome) => {
        if (outcome === 'answered') this.markNodeAnswering(address);
        else this.markNodeUnresponsive(address, client);
      },
    );

    // Node clients are long-lived, so pick up rotated client cert/key material
    // from the primary adapter before every reconnect.
    client.on('reconnecting', () => {
      this.refreshNodeTls({ node, client, connectionId: ownerId, host });
    });

    // Add error handler to prevent unhandled error events
    // Only log each unique connection error once to avoid log spam
    //
    // The last error is kept because iovalkey reports a refused connection
    // (WRONGPASS, NOAUTH, a socket error) on this event and then rejects
    // connect() with its generic "Connection is closed.", which tells the
    // caller nothing about why. Only kept until connect() settles, so a
    // stored client does not hold on to its later errors.
    let lastError: Error | undefined;
    let connecting = true;
    client.on('error', (err) => {
      if (connecting) lastError = err;
      const errorCode = (err as any).code || err.name;
      const errorKey = `${key}-${host}:${port}-${errorCode}`;
      if (!this.loggedConnectionErrors.has(errorKey)) {
        this.logger.warn(
          `Cannot connect to node ${key.substring(0, 12)} at ${host}:${port}: ${err.message}`,
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
          setTimeout(() => reject(new Error(CONNECTION_TIMED_OUT)), this.CONNECTION_TIMEOUT),
        ),
      ]);
      connecting = false;
      lastError = undefined;
      this.markNodeAnswering(address);
      assertNotReleased(opening, address);

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
      let storeKey = key;
      let replaced = this.discoveredNodes.get(storeKey);
      if (replaced && replaced.client !== client && replaced.connectionId !== ownerId) {
        storeKey = `node:${ownerId}:${node.id}`;
        replaced = this.discoveredNodes.get(storeKey);
      }
      if (replaced && replaced.client !== client) {
        await this.closeNodeClient(replaced.client);
        assertNotReleased(opening, address);
      }

      this.discoveredNodes.set(storeKey, connection);
      this.logger.log(`Connected to node ${key} at ${host}:${port}`);

      // Clear logged errors for this node on successful connection
      this.clearNodeErrors(key);

      return client;
    } catch (connectError) {
      // Surface the server's reply (or the socket error) behind iovalkey's
      // generic rejection, so a credential refusal reads as one downstream
      // (isAuthErrorReply matches the code after the `: `). A rejection that
      // already is the emitted error, or came with no error event, is kept.
      const error =
        lastError && lastError !== connectError
          ? new Error(`Failed to connect to ${host}:${port}: ${lastError.message}`, { cause: lastError })
          : connectError;

      // Only log each unique connection error once to avoid spam
      const errorKey = `connect-${key}`;
      if (!this.loggedGetConnectionErrors.has(errorKey)) {
        // The reply itself, not the wrapped message, which repeats this prefix.
        const reason = lastError ?? connectError;
        this.logger.debug(
          `Failed to connect to node ${key} at ${host}:${port}: ${reason instanceof Error ? reason.message : reason}`,
        );
        // Prevent unbounded growth
        if (this.loggedGetConnectionErrors.size >= this.MAX_LOGGED_ERRORS) {
          this.loggedGetConnectionErrors.clear();
        }
        this.loggedGetConnectionErrors.add(errorKey);
      }

      await this.closeNodeClient(client);
      if ([connectError, lastError].some(isConnectTimeout)) this.markNodeUnresponsive(address);

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

  private nodeClientKey(nodeId: string, ownerId: string | undefined): string {
    const scoped = `node:${ownerId}:${nodeId}`;
    if (this.discoveredNodes.has(scoped)) return scoped;
    const shared = this.discoveredNodes.get(nodeId);
    return !shared || shared.connectionId === ownerId ? nodeId : scoped;
  }

  private async healthCheckNode(node: DiscoveredNode): Promise<NodeHealth> {
    const ownerId = this.connectionRegistry.getDefaultId() || undefined;
    try {
      const client = await this.getNodeConnection(node.id);
      const result = await Promise.race([
        client.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Health check timeout')), 2000),
        ),
      ]);

      const healthy = result === 'PONG';

      const connection = this.discoveredNodes.get(this.nodeClientKey(node.id, ownerId));
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
      const connection = this.discoveredNodes.get(this.nodeClientKey(node.id, ownerId));
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

  async releaseConnection(connectionId: string): Promise<void> {
    const owned = [...this.discoveredNodes].filter(([, connection]) => connection.connectionId === connectionId);
    for (const [key] of owned) this.discoveredNodes.delete(key);
    for (const opening of this.openingNodeClients) {
      if (opening.ownerId === connectionId) opening.released = true;
    }
    this.discoveryCacheByConnection.delete(connectionId);
    this.discoveryInFlight.delete(connectionId);
    this.releaseOwnNodeClient(connectionId);
    await Promise.allSettled(owned.map(([, connection]) => this.closeNodeClient(connection.client)));
  }

  /**
   * Drop and disconnect a node client a caller gave up waiting on. On a
   * socket that went silent the queued commands would otherwise each wait for
   * their own command timeout; disconnecting rejects them now, and the next
   * getNodeConnection opens a fresh client.
   */
  evictNodeClient(client: Valkey): void {
    for (const [key, connection] of this.discoveredNodes) {
      if (connection.client === client) this.discoveredNodes.delete(key);
    }
    client.disconnect();
  }

  async retainAddressConnections(connectionId: string, addrs: ReadonlySet<string>): Promise<void> {
    const prefix = `addr:${connectionId}:`;
    const dropped = [...this.discoveredNodes].filter(
      ([key]) => key.startsWith(prefix) && !addrs.has(key.slice(prefix.length)),
    );
    for (const [key] of dropped) this.discoveredNodes.delete(key);
    await Promise.allSettled(dropped.map(([, connection]) => this.closeNodeClient(connection.client)));
  }

  async disconnectAll(): Promise<void> {
    this.logger.log(`Disconnecting from ${this.discoveredNodes.size} nodes`);
    for (const opening of this.openingNodeClients) opening.released = true;

    await Promise.allSettled(
      Array.from(this.discoveredNodes.values(), (connection) => this.closeNodeClient(connection.client)),
    );
    this.discoveredNodes.clear();
    this.discoveryCacheByConnection.clear();
    for (const [key, own] of [...this.ownNodeClients]) this.dropOwnNodeClient(key, own);
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

  private findOldestConnection(handedOutBefore: number): string | null {
    let oldestNodeId: string | null = null;
    let oldestTime = handedOutBefore;

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
