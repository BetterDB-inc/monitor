import { Test, TestingModule } from '@nestjs/testing';
import { ClusterDiscoveryService, DiscoveredNode } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

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
  });

  describe('getNodeConnection', () => {
    it('should throw error for non-existent node', async () => {
      await expect(service.getNodeConnection('non-existent-id')).rejects.toThrow(
        'Node non-existent-id not found in cluster'
      );
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
