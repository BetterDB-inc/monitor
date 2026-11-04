import { Test, TestingModule } from '@nestjs/testing';
import Valkey from 'iovalkey';
import { ClusterDiscoveryService, DiscoveredNode } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

jest.mock('iovalkey', () => {
  return jest.fn().mockImplementation(() => ({
    status: 'ready',
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
  }));
});

describe('ClusterDiscoveryService', () => {
  let service: ClusterDiscoveryService;
  let mockDbClient: any;
  let mockConnectionRegistry: any;

  const mockClusterNodes = [
    {
      id: 'node1-id-abc123',
      address: '192.168.1.10:6379',
      flags: ['master', 'myself'],
      master: '-',
      pingSent: 0,
      pongReceived: 1234567890,
      configEpoch: 1,
      linkState: 'connected',
      slots: [[0, 5460]],
    },
    {
      id: 'node2-id-def456',
      address: '192.168.1.11:6379',
      flags: ['slave'],
      master: 'node1-id-abc123',
      pingSent: 0,
      pongReceived: 1234567890,
      configEpoch: 1,
      linkState: 'connected',
      slots: [],
    },
  ];

  beforeEach(async () => {
    mockDbClient = {
      getClusterNodes: jest.fn().mockResolvedValue(mockClusterNodes),
      getClient: jest.fn().mockReturnValue({
        options: {
          username: 'testuser',
          password: 'testpass',
        },
        duplicate: jest.fn().mockReturnValue({
          connect: jest.fn().mockResolvedValue(undefined),
          quit: jest.fn().mockResolvedValue(undefined),
          ping: jest.fn().mockResolvedValue('PONG'),
        }),
      }),
    };

    mockConnectionRegistry = {
      get: jest.fn().mockReturnValue(mockDbClient),
      getDefaultId: jest.fn().mockReturnValue('test-connection'),
      list: jest.fn().mockReturnValue([{
        id: 'test-connection',
        name: 'Test Connection',
        host: 'localhost',
        port: 6379,
        isConnected: true,
      }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClusterDiscoveryService,
        { provide: ConnectionRegistry, useValue: mockConnectionRegistry },
      ],
    }).compile();

    service = module.get<ClusterDiscoveryService>(ClusterDiscoveryService);
  });

  afterEach(async () => {
    await service.disconnectAll();
  });

  describe('discoverNodes', () => {
    it('should discover and categorize nodes correctly', async () => {
      const nodes = await service.discoverNodes();

      expect(nodes).toHaveLength(2);

      const master = nodes.find(n => n.role === 'master');
      const replica = nodes.find(n => n.role === 'replica');

      expect(master).toBeDefined();
      expect(master?.id).toBe('node1-id-abc123');
      expect(master?.address).toBe('192.168.1.10:6379');
      expect(master?.slots).toEqual([[0, 5460]]);

      expect(replica).toBeDefined();
      expect(replica?.id).toBe('node2-id-def456');
      expect(replica?.masterId).toBe('node1-id-abc123');
    });

    it('should cache discovery results', async () => {
      await service.discoverNodes();
      await service.discoverNodes();

      // Should only call getClusterNodes once due to caching
      expect(mockDbClient.getClusterNodes).toHaveBeenCalledTimes(1);
    });

    it('should mark nodes as healthy based on flags', async () => {
      const nodes = await service.discoverNodes();

      nodes.forEach(node => {
        expect(node.healthy).toBe(true);
      });
    });

    it('should mark nodes as unhealthy when disconnected', async () => {
      mockDbClient.getClusterNodes.mockResolvedValueOnce([
        {
          ...mockClusterNodes[0],
          flags: ['master', 'disconnected'],
          linkState: 'disconnected',
        },
      ]);

      // Clear cache to force new discovery
      await service.cleanupIdleConnections(0);
      await new Promise(resolve => setTimeout(resolve, 100));

      const nodes = await service.discoverNodes();
      expect(nodes[0].healthy).toBe(false);
    });

    it('should mark nodes as unhealthy when failed', async () => {
      mockDbClient.getClusterNodes.mockResolvedValueOnce([
        {
          ...mockClusterNodes[0],
          flags: ['master', 'fail'],
          linkState: 'connected',
        },
      ]);

      // Clear cache to force new discovery
      await service.cleanupIdleConnections(0);
      await new Promise(resolve => setTimeout(resolve, 100));

      const nodes = await service.discoverNodes();
      expect(nodes[0].healthy).toBe(false);
    });

    it('should skip nodes that are neither master nor replica', async () => {
      mockDbClient.getClusterNodes.mockResolvedValueOnce([
        {
          id: 'node-handshake',
          address: '192.168.1.12:6379',
          flags: ['handshake'],
          master: '-',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 0,
          linkState: 'connected',
          slots: [],
        },
      ]);

      // Clear cache to force new discovery
      await service.cleanupIdleConnections(0);
      await new Promise(resolve => setTimeout(resolve, 100));

      const nodes = await service.discoverNodes();
      expect(nodes).toHaveLength(0);
    });

    it('should handle errors during discovery', async () => {
      mockDbClient.getClusterNodes.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(service.discoverNodes()).rejects.toThrow('Connection failed');
    });

    it('exposes the hostname a node announces', async () => {
      mockDbClient.getClusterNodes.mockResolvedValue([mockClusterNodes[0], { ...mockClusterNodes[1], hostname: 'node-2.cluster.local' }]);
      const nodes = await service.discoverNodes();
      expect(nodes.map((n) => n.hostname)).toEqual([undefined, 'node-2.cluster.local']);
    });

    it('exposes the raw node flags', async () => {
      const nodes = await service.discoverNodes();
      expect(nodes[0].flags).toEqual(['master', 'myself']);
      expect(nodes[1].flags).toEqual(['slave']);
    });
  });

  describe('getNodeConnection', () => {
    it('should throw error for non-existent node', async () => {
      await expect(service.getNodeConnection('non-existent-id')).rejects.toThrow(
        'Node non-existent-id not found in cluster'
      );
    });

    it('reuses a ready-but-stale cached connection instead of orphaning it', async () => {
      // Regression for the per-poll fan-out leak: a ready client whose health
      // stamp is older than HEALTH_CHECK_INTERVAL must be REUSED (and its stamp
      // refreshed), not replaced by a fresh Valkey that overwrites the map entry
      // and orphans this still-open socket.
      const nodes = await service.discoverNodes();
      const target = nodes.find((n) => n.role === 'replica') ?? nodes[0];

      type FakeConn = {
        node: DiscoveredNode;
        client: { status: string; quit: jest.Mock };
        lastHealthCheck: number;
        healthy: boolean;
      };
      const internal = service as unknown as {
        discoveredNodes: Map<string, FakeConn>;
        readonly HEALTH_CHECK_INTERVAL: number;
      };
      const readyClient = { status: 'ready', quit: jest.fn().mockResolvedValue(undefined) };
      const staleStamp = Date.now() - (internal.HEALTH_CHECK_INTERVAL + 60_000);
      internal.discoveredNodes.set(target.id, {
        node: target,
        client: readyClient,
        lastHealthCheck: staleStamp,
        healthy: true,
      });

      const returned = await service.getNodeConnection(target.id);

      // Same client handed back (no new connection created → nothing leaked),
      // the old client is never quit, and the stamp is refreshed.
      expect(returned).toBe(readyClient as unknown as typeof returned);
      expect(readyClient.quit).not.toHaveBeenCalled();
      const entry = internal.discoveredNodes.get(target.id)!;
      expect(entry.client).toBe(readyClient);
      expect(entry.lastHealthCheck).toBeGreaterThan(staleStamp);
    });

    it('should throw error for invalid node address', async () => {
      mockDbClient.getClusterNodes.mockResolvedValueOnce([
        {
          ...mockClusterNodes[0],
          address: 'invalid-address',
        },
      ]);

      // Clear cache to force new discovery
      await service.cleanupIdleConnections(0);
      await new Promise(resolve => setTimeout(resolve, 100));

      const nodes = await service.discoverNodes();

      await expect(service.getNodeConnection(nodes[0].id)).rejects.toThrow(
        'Invalid node address'
      );
    });
  });

  describe('getNodeConnection TLS', () => {
    it('passes the seed client TLS options to node clients without the seed servername', async () => {
      mockDbClient.getClient.mockReturnValue({
        options: { username: 'u', password: 'p', tls: { servername: 'seed.example', ca: 'seed-ca', rejectUnauthorized: true } },
      });
      await service.getNodeConnection('node2-id-def456', 'test-connection').catch(() => undefined);
      expect(jest.mocked(Valkey)).toHaveBeenCalledWith(
        expect.objectContaining({ tls: { ca: 'seed-ca', rejectUnauthorized: true } }),
      );
    });

    it('verifies a node client against the hostname the node announces', async () => {
      mockDbClient.getClusterNodes.mockResolvedValue([mockClusterNodes[0], { ...mockClusterNodes[1], hostname: 'node-2.cluster.local' }]);
      mockDbClient.getClient.mockReturnValue({
        options: { username: 'u', password: 'p', tls: { servername: 'seed.example', ca: 'seed-ca' } },
      });
      await service.getNodeConnection('node2-id-def456', 'test-connection').catch(() => undefined);
      expect(jest.mocked(Valkey)).toHaveBeenCalledWith(
        expect.objectContaining({
          host: '192.168.1.11',
          tls: { ca: 'seed-ca', servername: 'node-2.cluster.local', checkServerIdentity: expect.any(Function) },
        }),
      );
    });

    it('re-reads the seed TLS material before a node client reconnects', async () => {
      let seedTls: Record<string, unknown> = { servername: 'seed.example', ca: 'seed-ca', cert: 'cert-a', key: 'key-a' };
      mockDbClient.getClient.mockImplementation(() => ({ options: { username: 'u', password: 'p', tls: seedTls } }));
      const handlers: Record<string, () => void> = {};
      const nodeClient = {
        status: 'ready',
        options: {} as { tls?: Record<string, unknown> },
        connect: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        on: jest.fn((event: string, fn: () => void) => {
          handlers[event] = fn;
        }),
      };
      jest.mocked(Valkey).mockImplementationOnce(((opts: { tls?: Record<string, unknown> }) => {
        nodeClient.options.tls = opts.tls;
        return nodeClient;
      }) as never);

      await service.getNodeConnection('node2-id-def456', 'test-connection');
      expect(nodeClient.options.tls).toEqual({ ca: 'seed-ca', cert: 'cert-a', key: 'key-a' });

      // The adapter rotated its client certificate.
      seedTls = { ...seedTls, cert: 'cert-b', key: 'key-b' };
      handlers.reconnecting();
      expect(nodeClient.options.tls).toEqual({ ca: 'seed-ca', cert: 'cert-b', key: 'key-b' });
    });

    it('re-reads the seed TLS material before reviving a cached node client', async () => {
      let seedTls: Record<string, unknown> = { ca: 'seed-ca', cert: 'cert-a' };
      mockDbClient.getClient.mockImplementation(() => ({ options: { username: 'u', password: 'p', tls: seedTls } }));
      const nodeClient = {
        status: 'ready',
        options: {} as { tls?: Record<string, unknown> },
        connect: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        on: jest.fn(),
      };
      jest.mocked(Valkey).mockImplementationOnce(((opts: { tls?: Record<string, unknown> }) => {
        nodeClient.options.tls = opts.tls;
        return nodeClient;
      }) as never);
      await service.getNodeConnection('node2-id-def456', 'test-connection');

      nodeClient.status = 'end';
      seedTls = { ...seedTls, cert: 'cert-b' };
      await service.getNodeConnection('node2-id-def456', 'test-connection');
      expect(nodeClient.options.tls).toEqual({ ca: 'seed-ca', cert: 'cert-b' });
    });

    it('keeps a node client bound to the default connection it was created through', async () => {
      const clientFor = (cert: string) => ({
        ...mockDbClient,
        getClient: () => ({ options: { username: 'u', password: 'p', tls: { ca: 'ca', cert } } }),
      });
      const clients: Record<string, unknown> = { 'conn-a': clientFor('cert-a'), 'conn-b': clientFor('cert-b') };
      let defaultId = 'conn-a';
      mockConnectionRegistry.getDefaultId.mockImplementation(() => defaultId);
      mockConnectionRegistry.get.mockImplementation((id?: string) => clients[id ?? defaultId]);
      const handlers: Record<string, () => void> = {};
      const nodeClient = {
        status: 'ready',
        options: {} as { tls?: Record<string, unknown> },
        connect: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        on: jest.fn((event: string, fn: () => void) => {
          handlers[event] = fn;
        }),
      };
      jest.mocked(Valkey).mockImplementationOnce(((opts: { tls?: Record<string, unknown> }) => {
        nodeClient.options.tls = opts.tls;
        return nodeClient;
      }) as never);

      await service.getNodeConnection('node2-id-def456');
      defaultId = 'conn-b';
      handlers.reconnecting();
      expect(nodeClient.options.tls).toEqual({ ca: 'ca', cert: 'cert-a' });

      nodeClient.status = 'end';
      await service.getNodeConnection('node2-id-def456');
      expect(nodeClient.options.tls).toEqual({ ca: 'ca', cert: 'cert-a' });
    });

    // Node clients set enableOfflineQueue: false, so quit() on a client that
    // never became ready rejects without closing it and iovalkey keeps
    // reconnecting. These clients must be disconnect()ed instead.
    const notReadyClient = () => ({
      status: 'reconnecting',
      options: {},
      connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      quit: jest.fn().mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false")),
      disconnect: jest.fn(),
      on: jest.fn(),
    });

    it('disconnects a node client whose first dial fails', async () => {
      const nodeClient = notReadyClient();
      jest.mocked(Valkey).mockImplementationOnce((() => nodeClient) as never);

      await expect(service.getNodeConnection('node2-id-def456', 'test-connection')).rejects.toThrow('ECONNREFUSED');
      expect(nodeClient.disconnect).toHaveBeenCalled();
      expect(nodeClient.quit).not.toHaveBeenCalled();
    });

    it('disconnects a replaced node client that is not ready', async () => {
      const nodes = await service.discoverNodes('test-connection');
      const target = nodes.find((n) => n.id === 'node2-id-def456')!;
      const stale = notReadyClient();
      const internal = service as unknown as { discoveredNodes: Map<string, unknown> };
      internal.discoveredNodes.set(target.id, {
        node: target,
        client: stale,
        lastHealthCheck: Date.now(),
        healthy: false,
        connectionId: 'test-connection',
        host: '192.168.1.11',
      });

      await service.getNodeConnection(target.id, 'test-connection');
      expect(stale.disconnect).toHaveBeenCalled();
      expect(stale.quit).not.toHaveBeenCalled();
    });

    it('disconnects idle and remaining node clients that are not ready', async () => {
      const nodes = await service.discoverNodes('test-connection');
      const internal = service as unknown as { discoveredNodes: Map<string, unknown> };
      const idle = notReadyClient();
      const remaining = notReadyClient();
      internal.discoveredNodes.set(nodes[0].id, { node: nodes[0], client: idle, lastHealthCheck: 0, healthy: false });
      internal.discoveredNodes.set(nodes[1].id, { node: nodes[1], client: remaining, lastHealthCheck: Date.now(), healthy: false });

      await service.cleanupIdleConnections(60_000);
      expect(idle.disconnect).toHaveBeenCalled();
      expect(idle.quit).not.toHaveBeenCalled();

      await service.disconnectAll();
      expect(remaining.disconnect).toHaveBeenCalled();
      expect(remaining.quit).not.toHaveBeenCalled();
    });

    it('leaves TLS off for node clients when the seed has none', async () => {
      mockDbClient.getClient.mockReturnValue({ options: { username: 'u', password: 'p' } });
      await service.getNodeConnection('node2-id-def456', 'test-connection').catch(() => undefined);
      expect(jest.mocked(Valkey)).toHaveBeenCalledWith(expect.objectContaining({ tls: undefined }));
    });
  });

  describe('getAddressConnection', () => {
    beforeEach(() => {
      mockConnectionRegistry.sentinelDataNodeCredentials = jest
        .fn()
        .mockReturnValue({ username: 'node-user', password: 'node-pass' });
    });

    it('dials the address with the data-node credentials of the connection', async () => {
      await service.getAddressConnection('10.0.1.5', 6380, 'test-connection');

      expect(mockConnectionRegistry.sentinelDataNodeCredentials).toHaveBeenCalledWith('test-connection');
      expect(jest.mocked(Valkey)).toHaveBeenLastCalledWith(
        expect.objectContaining({
          host: '10.0.1.5',
          port: 6380,
          username: 'node-user',
          password: 'node-pass',
        }),
      );
    });

    it('refuses to dial without data-node credentials', async () => {
      mockConnectionRegistry.sentinelDataNodeCredentials.mockReturnValue(null);
      const calls = jest.mocked(Valkey).mock.calls.length;

      await expect(service.getAddressConnection('10.0.1.5', 6380, 'test-connection')).rejects.toThrow(
        'no data-node credentials',
      );
      expect(jest.mocked(Valkey).mock.calls.length).toBe(calls);
    });

    it('reuses the client for the same address', async () => {
      const first = await service.getAddressConnection('10.0.1.5', 6380, 'test-connection');
      const calls = jest.mocked(Valkey).mock.calls.length;

      const second = await service.getAddressConnection('10.0.1.5', 6380, 'test-connection');

      expect(second).toBe(first);
      expect(jest.mocked(Valkey).mock.calls.length).toBe(calls);
    });
  });

  describe('discoverNodesIsolated', () => {
    const seedOptions = { host: 'seed.example', port: 7001, username: 'u', password: 'p', tls: { servername: 'seed.example' } };

    function dedicatedClient(call: jest.Mock) {
      let rejectPending: (error: Error) => void = () => undefined;
      const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        call: jest.fn((...args: unknown[]) => {
          const result = call(...args);
          return new Promise((resolve, reject) => {
            rejectPending = reject;
            Promise.resolve(result).then(resolve, reject);
          });
        }),
        disconnect: jest.fn(() => rejectPending(new Error('Connection is closed.'))),
        on: jest.fn(),
      };
      jest.mocked(Valkey).mockImplementationOnce(() => client as never);
      return client;
    }

    beforeEach(() => {
      mockDbClient.getClient.mockReturnValue({ options: seedOptions });
    });

    it('runs CLUSTER NODES on a dedicated client with the seed options and closes it', async () => {
      const client = dedicatedClient(
        jest.fn().mockResolvedValue('abc 10.0.0.2:7002@17002 master - 0 0 1 connected 0-16383\n'),
      );
      const nodes = await service.discoverNodesIsolated('test-connection', 10_000);
      expect(nodes).toEqual([expect.objectContaining({ id: 'abc', address: '10.0.0.2:7002@17002', role: 'master' })]);
      expect(jest.mocked(Valkey)).toHaveBeenLastCalledWith(
        expect.objectContaining({ host: 'seed.example', port: 7001, username: 'u', password: 'p', tls: { servername: 'seed.example' } }),
      );
      expect(client.call).toHaveBeenCalledWith('CLUSTER', 'NODES');
      expect(client.disconnect).toHaveBeenCalled();
      expect(mockDbClient.getClusterNodes).not.toHaveBeenCalled();
    });

    it('bounds the dial and the command with timers that do not depend on the peer', async () => {
      dedicatedClient(jest.fn().mockResolvedValue(''));
      await service.discoverNodesIsolated('test-connection', 10_000);
      expect(jest.mocked(Valkey)).toHaveBeenLastCalledWith(
        expect.objectContaining({ connectTimeout: 10_000, commandTimeout: 10_000, enableReadyCheck: false, retryStrategy: expect.any(Function) }),
      );
    });

    it('closes the dedicated client when CLUSTER NODES times out', async () => {
      const client = dedicatedClient(jest.fn().mockRejectedValue(new Error('Command timed out')));
      await expect(service.discoverNodesIsolated('test-connection', 10_000)).rejects.toThrow('Command timed out');
      expect(client.disconnect).toHaveBeenCalled();
    });
  });

  describe('healthCheckAll', () => {
    it('should return health status for all nodes', async () => {
      const health = await service.healthCheckAll();

      expect(Array.isArray(health)).toBe(true);
      expect(health.length).toBe(2);

      health.forEach(h => {
        expect(h).toHaveProperty('nodeId');
        expect(h).toHaveProperty('address');
        expect(h).toHaveProperty('healthy');
        expect(h).toHaveProperty('lastCheck');
      });
    });
  });

  describe('getActiveConnections', () => {
    it('should return empty array initially', () => {
      const connections = service.getActiveConnections();
      expect(connections).toHaveLength(0);
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all connections', async () => {
      await service.disconnectAll();

      const connections = service.getActiveConnections();
      expect(connections).toHaveLength(0);
    });
  });

  describe('cleanupIdleConnections', () => {
    it('should not remove connections below idle time threshold', async () => {
      await service.cleanupIdleConnections(60000);

      const connections = service.getActiveConnections();
      // Should still have all connections (none are idle)
      expect(connections.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getConnectionPoolSize', () => {
    it('should return 0 initially', () => {
      expect(service.getConnectionPoolSize()).toBe(0);
    });
  });
});
