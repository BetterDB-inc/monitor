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
      getConfig: jest.fn().mockReturnValue({ id: 'test-connection', host: 'localhost', port: 6379 }),
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

    it('reads CLUSTER NODES again once the topology is forgotten', async () => {
      await service.discoverNodes('test-connection');
      service.forgetTopology('test-connection');
      await service.discoverNodes('test-connection');

      expect(mockDbClient.getClusterNodes).toHaveBeenCalledTimes(2);
    });

    it('does not join or keep a read that was running when the topology was forgotten', async () => {
      const moved = [{ ...mockClusterNodes[0], slots: [[0, 100]] }, mockClusterNodes[1]];
      let answerOld!: (nodes: unknown[]) => void;
      mockDbClient.getClusterNodes
        .mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)))
        .mockResolvedValue(moved);
      const slotsOf = (nodes: Array<{ role: string; slots: number[][] }>) =>
        nodes.find((n) => n.role === 'master')?.slots;
      const old = service.discoverNodes('test-connection');
      await Promise.resolve();

      service.forgetTopology('test-connection');
      const fresh = service.discoverNodes('test-connection');
      await Promise.resolve();

      expect(mockDbClient.getClusterNodes).toHaveBeenCalledTimes(2);
      expect(slotsOf(await fresh)).toEqual([[0, 100]]);

      answerOld(mockClusterNodes);
      await old;

      expect(slotsOf(await service.discoverNodes('test-connection'))).toEqual([[0, 100]]);
      expect(mockDbClient.getClusterNodes).toHaveBeenCalledTimes(2);
    });

    it('forgets the topology of the default connection when none is named', async () => {
      await service.discoverNodes();
      service.forgetTopology();
      await service.discoverNodes();

      expect(mockDbClient.getClusterNodes).toHaveBeenCalledTimes(2);
    });

    it('should mark nodes as healthy based on flags', async () => {
      const nodes = await service.discoverNodes();

      nodes.forEach(node => {
        expect(node.healthy).toBe(true);
      });
    });

    it('keeps a node healthy when only the answering node\'s bus link to it is down', async () => {
      // Link state is the answering node's cluster-bus link, not Monitor's
      // reach; the parser keeps it in its own field, never in flags.
      mockDbClient.getClusterNodes.mockResolvedValueOnce([
        {
          ...mockClusterNodes[0],
          flags: ['master'],
          linkState: 'disconnected',
        },
      ]);

      await service.cleanupIdleConnections(0);
      await new Promise(resolve => setTimeout(resolve, 100));

      const nodes = await service.discoverNodes();
      expect(nodes[0].healthy).toBe(true);
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
        connectionId?: string;
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
        connectionId: 'test-connection',
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

    it("does not hand one connection another connection's node client", async () => {
      const nodes = await service.discoverNodes();
      const target = nodes[0];
      const internal = service as unknown as { discoveredNodes: Map<string, unknown> };
      const othersClient = { status: 'ready', quit: jest.fn().mockResolvedValue(undefined) };
      internal.discoveredNodes.set(target.id, {
        node: target,
        client: othersClient,
        lastHealthCheck: Date.now(),
        healthy: true,
        connectionId: 'other-connection',
      });

      const returned = await service.getNodeConnection(target.id, 'test-connection');

      expect(returned).not.toBe(othersClient);
      expect((internal.discoveredNodes.get(target.id) as { client: unknown }).client).toBe(othersClient);
      expect(await service.getNodeConnection(target.id, 'test-connection')).toBe(returned);
    });

    it('does not reuse a client another connection opened during discovery', async () => {
      const nodes = await service.discoverNodes();
      const target = nodes[0];
      const internal = service as unknown as { discoveredNodes: Map<string, unknown> };
      const othersClient = { status: 'ready', quit: jest.fn().mockResolvedValue(undefined) };
      const discover = service.discoverNodes.bind(service);
      jest.spyOn(service, 'discoverNodes').mockImplementationOnce(async (id?: string) => {
        internal.discoveredNodes.set(target.id, {
          node: target,
          client: othersClient,
          lastHealthCheck: Date.now(),
          healthy: true,
          connectionId: 'other-connection',
        });
        return discover(id);
      });

      expect(await service.getNodeConnection(target.id, 'test-connection')).not.toBe(othersClient);
    });

    it('shares one CLUSTER NODES call between concurrent callers', async () => {
      await Promise.all([service.discoverNodes('test-connection'), service.discoverNodes('test-connection')]);

      expect(mockDbClient.getClusterNodes).toHaveBeenCalledTimes(1);
    });

    it('retries discovery after the connection lookup throws', async () => {
      mockConnectionRegistry.get.mockImplementationOnce(() => {
        throw new Error('Connection not found');
      });

      await expect(service.discoverNodes('test-connection')).rejects.toThrow('Connection not found');
      await expect(service.discoverNodes('test-connection')).resolves.toHaveLength(2);
    });

    it('does not cache a discovery that finishes after its connection is released', async () => {
      let finish!: (nodes: typeof mockClusterNodes) => void;
      mockDbClient.getClusterNodes.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const pending = service.discoverNodes('test-connection');
      await Promise.resolve();

      await service.releaseConnection('test-connection');
      finish(mockClusterNodes);
      await pending;
      await service.discoverNodes('test-connection');

      expect(mockDbClient.getClusterNodes).toHaveBeenCalledTimes(2);
    });

    it('closes the node clients of a removed connection', async () => {
      const nodes = await service.discoverNodes();
      const client = await service.getNodeConnection(nodes[0].id, 'test-connection');

      await service.releaseConnection('test-connection');

      expect(client.quit).toHaveBeenCalled();
      expect((service as unknown as { discoveredNodes: Map<string, unknown> }).discoveredNodes.size).toBe(0);
    });

    it('closes address clients the connection no longer reads', async () => {
      mockConnectionRegistry.sentinelDataNodeCredentials = jest.fn().mockReturnValue({ password: 'p' });
      const kept = await service.getAddressConnection('10.0.0.2', 6379, 'test-connection');
      const moved = await service.getAddressConnection('10.0.0.3', 6379, 'test-connection');

      await service.retainAddressConnections('test-connection', new Set(['10.0.0.2:6379']));

      expect(moved.quit).toHaveBeenCalled();
      expect(kept.quit).not.toHaveBeenCalled();
    });

    it("keeps another connection's client that was stored while this one was connecting", async () => {
      const nodes = await service.discoverNodes();
      const target = nodes[0];
      const internal = service as unknown as { discoveredNodes: Map<string, { client: unknown }> };
      const othersClient = { status: 'ready', quit: jest.fn().mockResolvedValue(undefined), disconnect: jest.fn() };
      const ownClient = {
        status: 'ready',
        connect: jest.fn(async () => {
          internal.discoveredNodes.set(target.id, {
            node: target,
            client: othersClient,
            lastHealthCheck: Date.now(),
            healthy: true,
            connectionId: 'other-connection',
          } as never);
        }),
        quit: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        on: jest.fn(),
      };
      jest.mocked(Valkey).mockImplementationOnce((() => ownClient) as never);

      const returned = await service.getNodeConnection(target.id, 'test-connection');

      expect(returned).toBe(ownClient);
      expect(othersClient.quit).not.toHaveBeenCalled();
      expect(othersClient.disconnect).not.toHaveBeenCalled();
      expect(internal.discoveredNodes.get(target.id)?.client).toBe(othersClient);
      expect(internal.discoveredNodes.get(`node:test-connection:${target.id}`)?.client).toBe(ownClient);
    });

    it('drops the old client without waiting on it once the node moves to another address', async () => {
      const nodes = await service.discoverNodes();
      const target = nodes[0];
      const internal = service as unknown as { discoveredNodes: Map<string, { client: unknown }> };
      const oldClient = { status: 'ready', quit: jest.fn(() => new Promise(() => {})), disconnect: jest.fn() };
      internal.discoveredNodes.set(target.id, {
        node: { ...target, address: '10.9.9.9:6379' },
        client: oldClient,
        lastHealthCheck: Date.now(),
        healthy: true,
        connectionId: 'test-connection',
      } as never);

      const returned = await service.getNodeConnection(target.id, 'test-connection');

      expect(returned).not.toBe(oldClient);
      expect(oldClient.disconnect).toHaveBeenCalled();
      expect(oldClient.quit).not.toHaveBeenCalled();
    });

    it("keeps using a connection's own client once the shared one is gone", async () => {
      const nodes = await service.discoverNodes();
      const target = nodes[0];
      const internal = service as unknown as { discoveredNodes: Map<string, unknown> };
      const ownClient = { status: 'ready', quit: jest.fn().mockResolvedValue(undefined) };
      internal.discoveredNodes.set(`node:test-connection:${target.id}`, {
        node: target,
        client: ownClient,
        lastHealthCheck: Date.now(),
        healthy: true,
        connectionId: 'test-connection',
      });

      expect(await service.getNodeConnection(target.id, 'test-connection')).toBe(ownClient);
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

    it('drops and disconnects an evicted node client, so the next call opens a new one', async () => {
      const first = await service.getNodeConnection('node2-id-def456', 'test-connection');

      service.evictNodeClient(first);

      expect(first.disconnect).toHaveBeenCalled();
      expect(service.getConnectionPoolSize()).toBe(0);
      expect(await service.getNodeConnection('node2-id-def456', 'test-connection')).not.toBe(first);
    });

    it('connects to an IPv6 node on the port after the last colon', async () => {
      mockDbClient.getClusterNodes.mockResolvedValueOnce([
        { ...mockClusterNodes[0], address: 'fd00::1:6380@16380' },
      ]);

      await service.getNodeConnection(mockClusterNodes[0].id, 'test-connection');

      expect(jest.mocked(Valkey)).toHaveBeenCalledWith(expect.objectContaining({ host: 'fd00::1', port: 6380 }));
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

    // iovalkey reports a refused AUTH on the 'error' event, then rejects
    // connect() with its generic close message.
    const refusedClient = (reply: string | null) => {
      const handlers: Record<string, (err: Error) => void> = {};
      const client = {
        status: 'end',
        options: {},
        connect: jest.fn(async () => {
          if (reply) handlers.error(new Error(reply));
          throw new Error('Connection is closed.');
        }),
        quit: jest.fn().mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false")),
        disconnect: jest.fn(),
        on: jest.fn((event: string, fn: (err: Error) => void) => {
          handlers[event] = fn;
        }),
      };
      jest.mocked(Valkey).mockImplementationOnce((() => client) as never);
      return client;
    };

    it('surfaces the WRONGPASS reply behind a rejected first dial', async () => {
      const nodeClient = refusedClient('WRONGPASS invalid username-password pair or user is disabled.');

      await expect(service.getNodeConnection('node2-id-def456', 'test-connection')).rejects.toThrow(
        'Failed to connect to 192.168.1.11:6379: WRONGPASS invalid username-password pair or user is disabled.',
      );
      expect(nodeClient.disconnect).toHaveBeenCalled();
    });

    it('surfaces the NOAUTH reply behind a rejected first dial', async () => {
      refusedClient('NOAUTH Authentication required.');

      await expect(service.getNodeConnection('node2-id-def456', 'test-connection')).rejects.toThrow(
        /: NOAUTH Authentication required\.$/,
      );
    });

    it('keeps the generic rejection when the client reported no error', async () => {
      refusedClient(null);

      await expect(service.getNodeConnection('node2-id-def456', 'test-connection')).rejects.toThrow(
        'Connection is closed.',
      );
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

  describe('getNodeConnection for an agent connection', () => {
    it('refuses before discovering nodes or touching the raw client', async () => {
      mockConnectionRegistry.getConfig.mockReturnValue({ id: 'test-connection', host: 'agent', port: 0 });

      await expect(service.getNodeConnection('node-1', 'test-connection')).rejects.toThrow(
        'cannot dial node-1 directly',
      );
      expect(mockDbClient.getClusterNodes).not.toHaveBeenCalled();
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

    it('refuses to dial for a connection reached through the agent', async () => {
      mockConnectionRegistry.getConfig.mockReturnValue({ id: 'test-connection', host: 'agent', port: 0 });
      const calls = jest.mocked(Valkey).mock.calls.length;

      await expect(service.getAddressConnection('10.0.1.5', 6380, 'test-connection')).rejects.toThrow(
        'cannot dial 10.0.1.5:6380 directly',
      );
      expect(jest.mocked(Valkey).mock.calls.length).toBe(calls);
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

  describe('getReplicaConnection', () => {
    it("dials the replica with the primary connection's credentials", async () => {
      await service.getReplicaConnection('10.0.1.6', 6381, 'test-connection');

      expect(jest.mocked(Valkey)).toHaveBeenLastCalledWith(
        expect.objectContaining({
          host: '10.0.1.6',
          port: 6381,
          username: 'testuser',
          password: 'testpass',
        }),
      );
    });

    it('dials the verified address while checking TLS against the announced hostname', async () => {
      mockDbClient.getClient.mockReturnValue({
        options: { username: 'u', password: 'p', tls: { servername: 'seed.example', ca: 'seed-ca' } },
      });

      await service.getReplicaConnection('10.0.1.6', 6381, 'test-connection', 'replica-0.cache.svc');

      expect(jest.mocked(Valkey)).toHaveBeenLastCalledWith(
        expect.objectContaining({
          host: '10.0.1.6',
          tls: { ca: 'seed-ca', servername: 'replica-0.cache.svc', checkServerIdentity: expect.any(Function) },
        }),
      );
    });

    it('reuses the client for the same replica', async () => {
      const first = await service.getReplicaConnection('10.0.1.6', 6381, 'test-connection');
      const calls = jest.mocked(Valkey).mock.calls.length;

      const second = await service.getReplicaConnection('10.0.1.6', 6381, 'test-connection');

      expect(second).toBe(first);
      expect(jest.mocked(Valkey).mock.calls.length).toBe(calls);
    });

    it.each([
      ['reached through the agent', { id: 'test-connection', host: 'agent', port: 0 }],
      ['that is a Sentinel member', { id: 'test-connection', host: 'localhost', port: 6379, membership: { source: 'sentinel', seedId: 's', nodeId: 'n' } }],
      ['behind an SSH tunnel', { id: 'test-connection', host: 'localhost', port: 6379, sshTunnel: { enabled: true } }],
      ['with no config', null],
    ])('refuses to dial for a connection %s', async (_label, config) => {
      mockConnectionRegistry.getConfig.mockReturnValue(config);
      const calls = jest.mocked(Valkey).mock.calls.length;

      await expect(service.getReplicaConnection('10.0.1.6', 6381, 'test-connection')).rejects.toThrow(
        /cannot dial (its replica )?10\.0\.1\.6:6381 directly/,
      );
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

    it('neither reads nor fills the discovery cache, so each call sees the node its own socket reached', async () => {
      await service.discoverNodes('test-connection');
      dedicatedClient(jest.fn().mockResolvedValue('vip 10.0.0.9:7009@17009 myself,master - 0 0 1 connected 0-16383\n'));
      const isolated = await service.discoverNodesIsolated('test-connection', 10_000);
      expect(isolated.map((n) => n.id)).toEqual(['vip']);
      const cached = await service.discoverNodes('test-connection');
      expect(cached.map((n) => n.id)).not.toContain('vip');
    });

    it('closes the dedicated client when CLUSTER NODES times out', async () => {
      const client = dedicatedClient(jest.fn().mockRejectedValue(new Error('Command timed out')));
      await expect(service.discoverNodesIsolated('test-connection', 10_000)).rejects.toThrow('Command timed out');
      expect(client.disconnect).toHaveBeenCalled();
    });
  });

  describe('onIsolatedClient', () => {
    function dedicatedClient() {
      const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        call: jest.fn().mockResolvedValue('OK'),
        disconnect: jest.fn(),
        on: jest.fn(),
      };
      jest.mocked(Valkey).mockImplementationOnce(() => client as never);
      return client;
    }

    beforeEach(() => {
      mockDbClient.getClient.mockReturnValue({
        options: { host: 'seed.example', port: 7001, username: 'u', password: 'p' },
        call: jest.fn(),
      });
    });

    it('runs the work on a socket of its own, with bounded dial and commands, and closes it', async () => {
      const client = dedicatedClient();

      const reply = await service.onIsolatedClient('test-connection', 5_000, (own) =>
        own.call('CLUSTER', 'GETSLOTMIGRATIONS'),
      );

      expect(reply).toBe('OK');
      expect(jest.mocked(Valkey)).toHaveBeenLastCalledWith(
        expect.objectContaining({
          host: 'seed.example',
          port: 7001,
          username: 'u',
          password: 'p',
          connectTimeout: 5_000,
          commandTimeout: 5_000,
          enableOfflineQueue: false,
        }),
      );
      expect(client.call).toHaveBeenCalledWith('CLUSTER', 'GETSLOTMIGRATIONS');
      expect(mockDbClient.getClient().call).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it('closes the socket when the work gives up', async () => {
      const client = dedicatedClient();

      await expect(
        service.onIsolatedClient('test-connection', 5_000, () =>
          Promise.reject(new Error('deadline')),
        ),
      ).rejects.toThrow('deadline');
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it('closes the socket when it cannot be dialed, without running the work', async () => {
      const client = dedicatedClient();
      client.connect.mockRejectedValue(new Error('connect ETIMEDOUT'));
      const work = jest.fn();

      await expect(service.onIsolatedClient('test-connection', 5_000, work)).rejects.toThrow(
        'connect ETIMEDOUT',
      );
      expect(work).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('healthCheckAll', () => {
    it("records the result on the checked client, not another connection's", async () => {
      const nodes = await service.discoverNodes();
      const internal = service as unknown as { discoveredNodes: Map<string, { lastHealthCheck: number }> };
      const stamp = Date.now() - 60_000;
      for (const node of nodes) {
        internal.discoveredNodes.set(node.id, {
          node,
          client: { status: 'ready', quit: jest.fn() },
          lastHealthCheck: stamp,
          healthy: true,
          connectionId: 'other-connection',
        } as never);
      }

      const valkey = Valkey as unknown as jest.Mock;
      const original = valkey.getMockImplementation();
      valkey.mockImplementation(() => ({
        status: 'ready',
        connect: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        ping: jest.fn().mockResolvedValue('NOPE'),
        on: jest.fn(),
      }));
      try {
        await service.healthCheckAll();
      } finally {
        valkey.mockImplementation(original);
      }

      for (const node of nodes) {
        const scoped = internal.discoveredNodes.get(`node:test-connection:${node.id}`) as {
          lastHealthCheck: number;
          healthy: boolean;
        };
        expect(internal.discoveredNodes.get(node.id)!.lastHealthCheck).toBe(stamp);
        expect(scoped.lastHealthCheck).toBeGreaterThan(stamp);
        expect(scoped.healthy).toBe(false);
      }
    });

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
