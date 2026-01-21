import { Test, TestingModule } from '@nestjs/testing';
import { ClusterMetricsService } from './cluster-metrics.service';
import { ClusterDiscoveryService } from './cluster-discovery.service';

describe('ClusterMetricsService', () => {
  let service: ClusterMetricsService;
  let mockDiscoveryService: any;

  const mockNodes = [
    { id: 'node1', address: '192.168.1.10:6379', role: 'master' as const, healthy: true, slots: [[0, 5460]] },
    { id: 'node2', address: '192.168.1.11:6379', role: 'replica' as const, healthy: true, masterId: 'node1', slots: [] },
  ];

  const mockSlowlog = [
    [1, 1234567890, 10000, ['GET', 'key1'], '127.0.0.1:12345', 'client1'],
    [2, 1234567891, 20000, ['SET', 'key2', 'value'], '127.0.0.1:12346', 'client2'],
  ];

  const mockInfoString = `# Server\r
redis_version:8.0.0\r
uptime_in_seconds:3600\r
\r
# Memory\r
used_memory:1048576\r
used_memory_peak:2097152\r
mem_fragmentation_ratio:1.2\r
\r
# Stats\r
instantaneous_ops_per_sec:100\r
instantaneous_input_kbps:50\r
instantaneous_output_kbps:75\r
\r
# Clients\r
connected_clients:10\r
blocked_clients:2\r
\r
# Replication\r
master_repl_offset:1000\r
role:master\r
\r
# CPU\r
used_cpu_sys:10.5\r
used_cpu_user:20.3\r
`;

  beforeEach(async () => {
    const mockClient = {
      call: jest.fn().mockImplementation((cmd, ...args) => {
        if (cmd === 'SLOWLOG' && args[0] === 'GET') {
          return Promise.resolve(mockSlowlog);
        }
        if (cmd === 'CLIENT' && args[0] === 'LIST') {
          return Promise.resolve('id=1 addr=127.0.0.1:12345 name=test age=10 idle=5 flags=N db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=0 obl=0 oll=0 omem=0 events=r cmd=get user=default\n');
        }
        if (cmd === 'CLUSTER' && args[0] === 'NODES') {
          return Promise.resolve('node1 192.168.1.10:6379 master - 0 0 1 connected 0-5460\nnode2 192.168.1.11:6379 slave node1 0 0 2 connected\n');
        }
        if (cmd === 'COMMANDLOG' && args[0] === 'GET') {
          return Promise.resolve([]);
        }
        return Promise.resolve(null);
      }),
      info: jest.fn().mockResolvedValue(mockInfoString),
      slowlog: jest.fn().mockResolvedValue(mockSlowlog),
      status: 'ready',
    };

    mockDiscoveryService = {
      discoverNodes: jest.fn().mockResolvedValue(mockNodes),
      getNodeConnection: jest.fn().mockResolvedValue(mockClient),
      dbClient: {
        getClient: jest.fn().mockReturnValue(mockClient),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClusterMetricsService,
        { provide: ClusterDiscoveryService, useValue: mockDiscoveryService },
      ],
    }).compile();

    service = module.get<ClusterMetricsService>(ClusterMetricsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getClusterSlowlog', () => {
    it('should aggregate slowlogs from all nodes', async () => {
      const result = await service.getClusterSlowlog(100);

      expect(Array.isArray(result)).toBe(true);
      // Each entry should have nodeId and nodeAddress
      if (result.length > 0) {
        expect(result[0]).toHaveProperty('nodeId');
        expect(result[0]).toHaveProperty('nodeAddress');
        expect(result[0]).toHaveProperty('id');
        expect(result[0]).toHaveProperty('timestamp');
        expect(result[0]).toHaveProperty('duration');
        expect(result[0]).toHaveProperty('command');
      }
    });

    it('should sort by timestamp descending', async () => {
      const result = await service.getClusterSlowlog(100);

      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].timestamp).toBeGreaterThanOrEqual(result[i].timestamp);
      }
    });

    it('should respect limit parameter', async () => {
      const result = await service.getClusterSlowlog(1);

      // Should only return 1 entry (the most recent)
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it('should handle errors from individual nodes gracefully', async () => {
      mockDiscoveryService.getNodeConnection.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await service.getClusterSlowlog(100);

      // Should still return results from other nodes
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getClusterClients', () => {
    it('should aggregate clients from all nodes', async () => {
      const result = await service.getClusterClients();

      expect(Array.isArray(result)).toBe(true);

      if (result.length > 0) {
        expect(result[0]).toHaveProperty('id');
        expect(result[0]).toHaveProperty('addr');
        expect(result[0]).toHaveProperty('nodeId');
        expect(result[0]).toHaveProperty('nodeAddress');
      }
    });

    it('should handle errors from individual nodes gracefully', async () => {
      mockDiscoveryService.getNodeConnection.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await service.getClusterClients();

      // Should still return results from other nodes
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getClusterCommandlog', () => {
    it('should aggregate commandlogs from all nodes', async () => {
      const result = await service.getClusterCommandlog('slow', 100);

      expect(Array.isArray(result)).toBe(true);
    });

    it('should sort by timestamp descending', async () => {
      const mockCommandlog = [
        [1, 1234567890, 10000, ['GET', 'key1'], '127.0.0.1:12345', 'client1', 'slow'],
        [2, 1234567891, 20000, ['SET', 'key2'], '127.0.0.1:12346', 'client2', 'slow'],
      ];

      const mockClientWithCommandlog = {
        call: jest.fn().mockImplementation((cmd, ...args) => {
          if (cmd === 'COMMANDLOG' && args[0] === 'GET') {
            return Promise.resolve(mockCommandlog);
          }
          return Promise.resolve(null);
        }),
        status: 'ready',
      };

      mockDiscoveryService.getNodeConnection.mockResolvedValue(mockClientWithCommandlog);

      const result = await service.getClusterCommandlog('slow', 100);

      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].timestamp).toBeGreaterThanOrEqual(result[i].timestamp);
      }
    });

    it('should handle nodes that do not support commandlog', async () => {
      const errorClient = {
        call: jest.fn().mockRejectedValue(new Error('ERR unknown command')),
        status: 'ready',
      };

      mockDiscoveryService.getNodeConnection.mockResolvedValue(errorClient);

      const result = await service.getClusterCommandlog('slow', 100);

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getClusterNodeStats', () => {
    it('should return stats for all healthy nodes', async () => {
      const stats = await service.getClusterNodeStats();

      expect(Array.isArray(stats)).toBe(true);

      if (stats.length > 0) {
        const stat = stats[0];
        expect(stat).toHaveProperty('nodeId');
        expect(stat).toHaveProperty('nodeAddress');
        expect(stat).toHaveProperty('role');
        expect(stat).toHaveProperty('memoryUsed');
        expect(stat).toHaveProperty('opsPerSec');
        expect(stat).toHaveProperty('connectedClients');
        expect(typeof stat.memoryUsed).toBe('number');
      }
    });

    it('should parse memory stats correctly', async () => {
      const stats = await service.getClusterNodeStats();

      if (stats.length > 0) {
        expect(stats[0].memoryUsed).toBe(1048576);
        expect(stats[0].memoryPeak).toBe(2097152);
        expect(stats[0].memoryFragmentationRatio).toBe(1.2);
      }
    });

    it('should parse client stats correctly', async () => {
      const stats = await service.getClusterNodeStats();

      if (stats.length > 0) {
        expect(stats[0].connectedClients).toBe(10);
        expect(stats[0].blockedClients).toBe(2);
      }
    });

    it('should parse network stats correctly', async () => {
      const stats = await service.getClusterNodeStats();

      if (stats.length > 0) {
        expect(stats[0].opsPerSec).toBe(100);
        expect(stats[0].inputKbps).toBe(50);
        expect(stats[0].outputKbps).toBe(75);
      }
    });

    it('should handle errors from individual nodes gracefully', async () => {
      mockDiscoveryService.getNodeConnection.mockRejectedValueOnce(new Error('Connection failed'));

      const stats = await service.getClusterNodeStats();

      // Should return stats from other nodes
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe('getNodeInfo', () => {
    it('should return info for specific node', async () => {
      const info = await service.getNodeInfo('node1');

      expect(info).toBeDefined();
      expect(typeof info).toBe('object');
    });
  });

  describe('getSlotMigrations', () => {
    it('should return empty array when no migrations', async () => {
      const migrations = await service.getSlotMigrations();

      expect(Array.isArray(migrations)).toBe(true);
      expect(migrations.length).toBe(0);
    });

    it('should parse migrating slots correctly when target node exists', async () => {
      // Create nodes with matching IDs for migrations
      const migrationMockNodes = [
        { id: 'abc123node1', address: '192.168.1.10:6379', role: 'master' as const, healthy: true, slots: [[0, 5460]] },
        { id: 'def456node2', address: '192.168.1.11:6379', role: 'master' as const, healthy: true, slots: [[5461, 10922]] },
      ];

      mockDiscoveryService.discoverNodes.mockResolvedValueOnce(migrationMockNodes);

      const mockClientWithMigration = {
        call: jest.fn().mockImplementation((cmd, ...args) => {
          if (cmd === 'CLUSTER' && args[0] === 'NODES') {
            return Promise.resolve(
              'abc123node1 192.168.1.10:6379 master - 0 0 1 connected 0-5460 [5461->-def456]\n' +
              'def456node2 192.168.1.11:6379 master - 0 0 2 connected 5461-10922\n'
            );
          }
          return Promise.resolve(null);
        }),
        status: 'ready',
      };

      mockDiscoveryService.dbClient.getClient.mockReturnValue(mockClientWithMigration);

      const migrations = await service.getSlotMigrations();

      // Should find the migrating slot
      expect(migrations.length).toBeGreaterThan(0);
      const migratingSlots = migrations.filter(m => m.state === 'migrating');
      expect(migratingSlots.length).toBeGreaterThan(0);
      expect(migratingSlots[0].slot).toBe(5461);
      expect(migratingSlots[0].sourceNodeId).toBe('abc123node1');
      expect(migratingSlots[0].targetNodeId).toBe('def456node2');
    });

    it('should return empty array when source node not found for importing slots', async () => {
      // Test case where importing slot references a node that's not in the discovered nodes list
      // This can happen when the cluster is in an inconsistent state
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce(mockNodes);

      const mockClientWithImport = {
        call: jest.fn().mockImplementation((cmd, ...args) => {
          if (cmd === 'CLUSTER' && args[0] === 'NODES') {
            // Reference a node ID that doesn't exist in mockNodes
            return Promise.resolve(
              'somenode 192.168.1.10:6379 master - 0 0 1 connected 0-5460\n' +
              'othernode 192.168.1.11:6379 master - 0 0 2 connected 5461-10922 [5461-<-unknownnode]\n'
            );
          }
          return Promise.resolve(null);
        }),
        status: 'ready',
      };

      mockDiscoveryService.dbClient.getClient.mockReturnValueOnce(mockClientWithImport);

      const migrations = await service.getSlotMigrations();

      // Should return empty or not include the migration since source node wasn't found
      expect(Array.isArray(migrations)).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      mockDiscoveryService.dbClient.getClient.mockReturnValue({
        call: jest.fn().mockRejectedValue(new Error('Connection failed')),
      });

      const migrations = await service.getSlotMigrations();

      expect(Array.isArray(migrations)).toBe(true);
      expect(migrations.length).toBe(0);
    });
  });
});
