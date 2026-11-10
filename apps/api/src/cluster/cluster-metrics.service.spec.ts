import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ClusterMetricsService } from './cluster-metrics.service';
import { ClusterDiscoveryService } from './cluster-discovery.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

describe('ClusterMetricsService', () => {
  let service: ClusterMetricsService;
  let mockDiscoveryService: { discoverNodes: jest.Mock; getNodeConnection: jest.Mock; evictNodeClient: jest.Mock };
  let mockConnectionRegistry: {
    get: jest.Mock;
    getDefaultId: jest.Mock;
    list: jest.Mock;
    getConfig: jest.Mock;
    listMembers: jest.Mock;
    findConfigByHostPort: jest.Mock;
  };
  let mockClient: { call: jest.Mock; info: jest.Mock; slowlog: jest.Mock; status: string };

  const mockNodes = [
    {
      id: 'node1',
      address: '192.168.1.10:6379',
      role: 'master' as const,
      healthy: true,
      slots: [[0, 5460]],
    },
    {
      id: 'node2',
      address: '192.168.1.11:6379',
      role: 'replica' as const,
      healthy: true,
      masterId: 'node1',
      slots: [],
    },
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

  const serverWriteCommands = new Set(['json.set', 'vadd']);
  const serverKnownCommands = new Set(['get', 'info', 'json.set', 'vadd']);

  function commandInfoEntry(name: string): unknown {
    if (!serverKnownCommands.has(name)) {
      return null;
    }
    const flags = serverWriteCommands.has(name) ? ['write', 'denyoom'] : ['readonly', 'fast'];
    return [name, -2, flags, 1, 1, 1];
  }

  beforeEach(async () => {
    mockClient = {
      call: jest.fn().mockImplementation((cmd, ...args) => {
        if (cmd === 'SLOWLOG' && args[0] === 'GET') {
          return Promise.resolve(mockSlowlog);
        }
        if (cmd === 'CLIENT' && args[0] === 'LIST') {
          return Promise.resolve(
            'id=1 addr=127.0.0.1:12345 name=test age=10 idle=5 flags=N db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=0 obl=0 oll=0 omem=0 events=r cmd=get user=default\n',
          );
        }
        if (cmd === 'CLUSTER' && args[0] === 'NODES') {
          return Promise.resolve(
            'node1 192.168.1.10:6379 master - 0 0 1 connected 0-5460\nnode2 192.168.1.11:6379 slave node1 0 0 2 connected\n',
          );
        }
        if (cmd === 'COMMANDLOG' && args[0] === 'GET') {
          return Promise.resolve([]);
        }
        if (cmd === 'COMMAND' && args[0] === 'INFO') {
          return Promise.resolve(
            args.slice(1).map((name: string) => {
              return commandInfoEntry(name);
            }),
          );
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
      evictNodeClient: jest.fn(),
    };

    mockConnectionRegistry = {
      get: jest.fn().mockReturnValue({
        getClient: jest.fn().mockReturnValue(mockClient),
      }),
      getDefaultId: jest.fn().mockReturnValue('test-connection'),
      list: jest.fn().mockReturnValue([]),
      getConfig: jest.fn().mockReturnValue({ id: 'test-connection' }),
      listMembers: jest.fn().mockReturnValue([]),
      findConfigByHostPort: jest.fn().mockReturnValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClusterMetricsService,
        { provide: ClusterDiscoveryService, useValue: mockDiscoveryService },
        { provide: ConnectionRegistry, useValue: mockConnectionRegistry },
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

    it('records the role the node reports for itself, alongside the topology role', async () => {
      const stats = await service.getClusterNodeStats();

      const replicaNode = stats.find((stat) => {
        return stat.nodeId === 'node2';
      });

      // The topology has demoted it; its own INFO has not caught up. That
      // disagreement is the data-loss window #413 detects.
      expect(replicaNode?.role).toBe('replica');
      expect(replicaNode?.selfReportedRole).toBe('master');
    });

    it('leaves write calls unread unless the caller asks for commandstats', async () => {
      const stats = await service.getClusterNodeStats();

      expect(stats[0].writeCommandCalls).toBeUndefined();
      expect(mockClient.info).not.toHaveBeenCalledWith('commandstats');
    });

    it('totals only write commands when commandstats is requested', async () => {
      mockClient.info.mockImplementation((section?: string) => {
        if (section === 'commandstats') {
          return Promise.resolve(
            '# Commandstats\r\n' +
              'cmdstat_get:calls=900,usec=1000,usec_per_call=1.11,rejected_calls=0,failed_calls=0\r\n' +
              'cmdstat_set:calls=30,usec=500,usec_per_call=16.67,rejected_calls=0,failed_calls=0\r\n' +
              'cmdstat_hset:calls=12,usec=200,usec_per_call=16.67,rejected_calls=0,failed_calls=0\r\n',
          );
        }
        return Promise.resolve(mockInfoString);
      });

      const stats = await service.getClusterNodeStats(undefined, { includeCommandStats: true });

      expect(stats[0].writeCommandCalls).toBe(42);
    });

    it('counts a module write the server classifies', async () => {
      mockClient.info.mockImplementation((section?: string) => {
        if (section === 'commandstats') {
          return Promise.resolve(
            '# Commandstats\r\n' +
              'cmdstat_get:calls=900,usec=1000,usec_per_call=1.11,rejected_calls=0,failed_calls=0\r\n' +
              'cmdstat_json.set:calls=40,usec=800,usec_per_call=20,rejected_calls=0,failed_calls=0\r\n',
          );
        }
        return Promise.resolve(mockInfoString);
      });

      const stats = await service.getClusterNodeStats(undefined, { includeCommandStats: true });

      expect(stats[0].writeCommandCalls).toBe(40);
    });

    it('reports no write calls rather than zero when the traffic cannot be classified', async () => {
      mockClient.info.mockImplementation((section?: string) => {
        if (section === 'commandstats') {
          return Promise.resolve(
            '# Commandstats\r\n' +
              'cmdstat_get:calls=900,usec=1000,usec_per_call=1.11,rejected_calls=0,failed_calls=0\r\n' +
              'cmdstat_mysteryctl:calls=40,usec=800,usec_per_call=20,rejected_calls=0,failed_calls=0\r\n',
          );
        }
        return Promise.resolve(mockInfoString);
      });

      const stats = await service.getClusterNodeStats(undefined, { includeCommandStats: true });

      expect(stats[0].writeCommandCalls).toBeUndefined();
    });

    it('counts a core write the built-in list does not name', async () => {
      mockClient.info.mockImplementation((section?: string) => {
        if (section === 'commandstats') {
          return Promise.resolve(
            '# Commandstats\r\n' +
              'cmdstat_vadd:calls=12,usec=800,usec_per_call=20,rejected_calls=0,failed_calls=0\r\n',
          );
        }
        return Promise.resolve(mockInfoString);
      });

      const stats = await service.getClusterNodeStats(undefined, { includeCommandStats: true });

      expect(stats[0].writeCommandCalls).toBe(12);
    });

    it('reports zero write calls when the node served only core reads', async () => {
      mockClient.info.mockImplementation((section?: string) => {
        if (section === 'commandstats') {
          return Promise.resolve(
            '# Commandstats\r\n' +
              'cmdstat_get:calls=900,usec=1000,usec_per_call=1.11,rejected_calls=0,failed_calls=0\r\n',
          );
        }
        return Promise.resolve(mockInfoString);
      });

      const stats = await service.getClusterNodeStats(undefined, { includeCommandStats: true });

      expect(stats[0].writeCommandCalls).toBe(0);
    });

    it('reports no write calls rather than zero when the node has no commandstats', async () => {
      mockClient.info.mockImplementation((section?: string) => {
        if (section === 'commandstats') {
          return Promise.reject(new Error('ERR unknown section'));
        }
        return Promise.resolve(mockInfoString);
      });

      const stats = await service.getClusterNodeStats(undefined, { includeCommandStats: true });

      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].writeCommandCalls).toBeUndefined();
    });

    it('reads only the nodes the caller asked for', async () => {
      const stats = await service.getClusterNodeStats(undefined, { nodeIds: ['node2'] });

      expect(stats.map((stat) => stat.nodeId)).toEqual(['node2']);
      expect(mockDiscoveryService.getNodeConnection).toHaveBeenCalledTimes(1);
    });

    it('reads nothing when the caller asked for an empty set of nodes', async () => {
      const stats = await service.getClusterNodeStats(undefined, { nodeIds: [] });

      expect(stats).toEqual([]);
      expect(mockDiscoveryService.getNodeConnection).not.toHaveBeenCalled();
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
    const primaries = [
      { id: 'abc123node1', address: '192.168.1.10:6379', flags: ['master'], role: 'master' as const, healthy: true, slots: [[0, 5460]] },
      { id: 'def456node2', address: '192.168.1.11:6379', flags: ['master'], role: 'master' as const, healthy: true, slots: [[5461, 10922]] },
      { id: 'fff789node3', address: '192.168.1.12:6379', flags: ['master'], role: 'master' as const, healthy: true, slots: [] },
    ];

    function nodeClients(byNode: Record<string, { nodes?: string; jobs?: unknown; jobsError?: Error }>) {
      mockDiscoveryService.getNodeConnection.mockImplementation(async (nodeId: string) => ({
        status: 'ready',
        call: jest.fn(async (cmd: string, sub: string) => {
          const reply = byNode[nodeId] ?? {};
          if (cmd === 'CLUSTER' && sub === 'NODES') return reply.nodes ?? '';
          if (cmd === 'CLUSTER' && sub === 'GETSLOTMIGRATIONS') {
            if (reply.jobsError) throw reply.jobsError;
            return reply.jobs ?? [];
          }
          return null;
        }),
      }));
    }

    it('should return empty array when no migrations', async () => {
      const migrations = await service.getSlotMigrations();

      expect(Array.isArray(migrations)).toBe(true);
      expect(migrations.length).toBe(0);
    });

    it('reads legacy MIGRATING markers from the node that owns them', async () => {
      // The marker is only on node1's own line, which only node1 reports.
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce(primaries);
      nodeClients({
        abc123node1: {
          nodes:
            'abc123node1 192.168.1.10:6379 myself,master - 0 0 1 connected 0-5460 [5461->-def456]\n' +
            'def456node2 192.168.1.11:6379 master - 0 0 2 connected 5461-10922\n',
        },
      });

      const migrations = await service.getSlotMigrations('conn-1');

      expect(migrations).toEqual([
        expect.objectContaining({ slot: 5461, sourceNodeId: 'abc123node1', targetNodeId: 'def456node2', state: 'migrating' }),
      ]);
      expect(mockDiscoveryService.discoverNodes).toHaveBeenCalledWith('conn-1');
    });

    it('reports an atomic slot migration job once, from either end', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce(primaries);
      const job = (operation: string) => [
        'name', 'job-1', 'operation', operation, 'slot_ranges', '0-1365',
        'target_node', 'fff789node3', 'source_node', 'abc123node1', 'state', 'snapshotting',
      ];
      nodeClients({
        abc123node1: { jobs: [job('EXPORT')] },
        fff789node3: { jobs: [job('IMPORT')] },
      });

      const migrations = await service.getSlotMigrations();

      expect(migrations).toHaveLength(1);
      expect(migrations[0]).toEqual(
        expect.objectContaining({
          slot: 0,
          slotRange: '0-1365',
          sourceNodeId: 'abc123node1',
          sourceAddress: '192.168.1.10:6379',
          targetNodeId: 'fff789node3',
          targetAddress: '192.168.1.12:6379',
          state: 'migrating',
          phase: 'snapshotting',
        }),
      );
    });

    it('leaves an endpoint blank when a job does not name its node', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce(primaries);
      nodeClients({
        fff789node3: {
          jobs: [['name', 'job-1', 'operation', 'IMPORT', 'slot_ranges', '0-10', 'target_node', 'fff789node3', 'state', 'snapshotting']],
        },
      });

      const [migration] = await service.getSlotMigrations();

      expect(migration).toEqual(expect.objectContaining({ sourceNodeId: '', sourceAddress: '', targetNodeId: 'fff789node3' }));
    });

    it('ignores finished atomic jobs and servers without GETSLOTMIGRATIONS', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce(primaries);
      nodeClients({
        abc123node1: { jobs: [['name', 'done', 'operation', 'EXPORT', 'slot_ranges', '1-2', 'state', 'success']] },
        def456node2: { jobsError: new Error('ERR unknown subcommand') },
      });

      await expect(service.getSlotMigrations()).resolves.toEqual([]);
    });

    it('keeps the MIGRATING view of a legacy move whichever node answers first', async () => {
      // Discovered target-first, so its IMPORTING marker is read first.
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce([primaries[1], primaries[0], primaries[2]]);
      nodeClients({
        def456node2: { nodes: 'def456node2 192.168.1.11:6379 myself,master - 0 0 2 connected 5461-10922 [100-<-abc123]\n' },
        abc123node1: { nodes: 'abc123node1 192.168.1.10:6379 myself,master - 0 0 1 connected 0-5460 [100->-def456]\n' },
      });

      const migrations = await service.getSlotMigrations();

      expect(migrations).toEqual([expect.objectContaining({ slot: 100, state: 'migrating' })]);
    });

    it('logs a GETSLOTMIGRATIONS failure that is not a missing subcommand', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce(primaries);
      nodeClients({ abc123node1: { jobsError: new Error('NOPERM this user has no permissions') } });
      const warn = jest.spyOn((service as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);

      await service.getSlotMigrations();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOPERM'));
    });

    it("reads the connection's own node when no primary can be reached directly, and warns once", async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValue(primaries);
      mockDiscoveryService.getNodeConnection.mockRejectedValue(new Error('connect ETIMEDOUT'));
      mockClient.call.mockImplementation(async (cmd: string, sub: string) =>
        cmd === 'CLUSTER' && sub === 'NODES'
          ? 'abc123node1 192.168.1.10:6379 myself,master - 0 0 1 connected 0-5460 [5461->-def456]\n'
          : null,
      );
      const warn = jest.spyOn((service as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);

      const migrations = await service.getSlotMigrations('conn-1');
      await service.getSlotMigrations('conn-1');

      expect(migrations).toEqual([
        expect.objectContaining({ slot: 5461, sourceNodeId: 'abc123node1', targetNodeId: 'def456node2', state: 'migrating' }),
      ]);
      expect(mockConnectionRegistry.get).toHaveBeenCalledWith('conn-1');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("reads atomic migration jobs through the connection's own node when no primary can be reached directly", async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValue(primaries);
      mockDiscoveryService.getNodeConnection.mockRejectedValue(new Error('connect ETIMEDOUT'));
      mockClient.call.mockImplementation(async (cmd: string, sub: string) => {
        if (cmd !== 'CLUSTER') return null;
        if (sub === 'NODES') return 'abc123node1 192.168.1.10:6379 myself,master - 0 0 1 connected 0-5460\n';
        if (sub === 'GETSLOTMIGRATIONS') {
          return [[
            'name', 'job-1', 'operation', 'EXPORT', 'slot_ranges', '0-1365',
            'target_node', 'fff789node3', 'source_node', 'abc123node1', 'state', 'snapshotting',
          ]];
        }
        return null;
      });

      const migrations = await service.getSlotMigrations('conn-1');

      expect(migrations).toEqual([
        expect.objectContaining({ slotRange: '0-1365', sourceNodeId: 'abc123node1', targetNodeId: 'fff789node3', state: 'migrating' }),
      ]);
    });

    it("stops waiting for the connection's own node when it does not answer", async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValue(primaries);
        mockDiscoveryService.getNodeConnection.mockRejectedValue(new Error('connect ETIMEDOUT'));
        mockClient.call.mockImplementation(() => new Promise(() => undefined));
        jest.spyOn((service as unknown as { logger: Logger }).logger, 'error').mockImplementation(() => undefined);

        let settled = false;
        const pending = service.getSlotMigrations('conn-1').finally(() => {
          settled = true;
        });
        await jest.advanceTimersByTimeAsync(5_000);

        expect(settled).toBe(true);
        await expect(pending).resolves.toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle errors gracefully', async () => {
      mockDiscoveryService.discoverNodes.mockRejectedValueOnce(new Error('Connection failed'));

      const migrations = await service.getSlotMigrations();

      expect(migrations).toEqual([]);
    });
  });

  describe('usesClusterWideSlotStats', () => {
    const memberOf = (seedId: string) => ({ seedId, nodeId: 'n', origin: 'auto', source: 'cluster' });

    it('is false for a node registered under a seed', async () => {
      mockConnectionRegistry.getConfig.mockReturnValue({ id: 'child', membership: memberOf('seed') });
      await expect(service.usesClusterWideSlotStats('child')).resolves.toBe(false);
    });

    it('is true for a seed with active members, without asking discovery', async () => {
      mockConnectionRegistry.getConfig.mockReturnValue({ id: 'seed' });
      mockConnectionRegistry.listMembers.mockReturnValue([{ id: 'child', membership: memberOf('seed') }]);
      await expect(service.usesClusterWideSlotStats('seed')).resolves.toBe(true);
      expect(mockDiscoveryService.discoverNodes).not.toHaveBeenCalled();
    });

    it('is true for the only registered connection of a cluster', async () => {
      mockConnectionRegistry.findConfigByHostPort.mockImplementation((host: string) =>
        host === '192.168.1.10' ? { id: 'test-connection' } : null,
      );
      await expect(service.usesClusterWideSlotStats()).resolves.toBe(true);
      expect(mockDiscoveryService.discoverNodes).toHaveBeenCalledWith('test-connection');
    });

    it('is false for each of several cluster nodes registered one by one', async () => {
      mockConnectionRegistry.findConfigByHostPort.mockImplementation((host: string) =>
        host === '192.168.1.10' ? { id: 'node-a' } : { id: 'node-b' },
      );
      await expect(service.usesClusterWideSlotStats('node-a')).resolves.toBe(false);
      await expect(service.usesClusterWideSlotStats('node-b')).resolves.toBe(false);
    });

    it('matches another registered node by the hostname it announces', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValue([
        { ...mockNodes[0], flags: ['myself', 'master'] },
        { ...mockNodes[1], hostname: 'node-2.example', flags: ['slave'] },
      ]);
      mockConnectionRegistry.findConfigByHostPort.mockImplementation((host: string) =>
        host === 'node-2.example' ? { id: 'node-b' } : null,
      );
      await expect(service.usesClusterWideSlotStats('node-a')).resolves.toBe(false);
    });

    it('counts an active member of a registered seed as covered by that seed', () => {
      mockConnectionRegistry.getConfig.mockImplementation((id: string) =>
        id === 'seed' ? { id: 'seed' } : { id, membership: id === 'retired' ? { ...memberOf('seed'), retiredAt: 1 } : memberOf('seed') },
      );
      expect(service.coveredBySeed('child')).toBe(true);
      expect(service.coveredBySeed('retired')).toBe(false);
      expect(service.coveredBySeed('seed')).toBe(false);
    });

    it('keeps its own node when discovery fails', async () => {
      mockDiscoveryService.discoverNodes.mockRejectedValue(new Error('down'));
      await expect(service.usesClusterWideSlotStats('node-a')).resolves.toBe(false);
    });
  });

  describe('getClusterSlotStats', () => {
    it('merges the slots of every primary and keeps the overall top N', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 8191]] },
        { id: 'r1', address: '10.0.0.2:6379', role: 'replica', healthy: true, slots: [] },
        { id: 'p2', address: '10.0.0.3:6379', role: 'master', healthy: true, slots: [[8192, 16383]] },
        { id: 'ghost', address: '10.0.0.4:6379', role: 'master', healthy: false, slots: [[0, 100]] },
      ]);
      const replies: Record<string, unknown> = {
        // p2 still reports slot 2 it just handed over; p1 owns it.
        p1: [[1, ['key-count', 50]], [2, ['key-count', 5]]],
        p2: [[9000, ['key-count', 70]], [9001, ['key-count', 1]], [2, ['key-count', 999]]],
      };
      const calls: unknown[][] = [];
      mockDiscoveryService.getNodeConnection.mockImplementation(async (nodeId: string) => ({
        call: jest.fn(async (...args: unknown[]) => {
          calls.push([nodeId, ...args]);
          return replies[nodeId];
        }),
      }));

      const result = await service.getClusterSlotStatsResult('key-count', 3, 'conn-1');

      expect(Object.keys(result.stats).sort()).toEqual(['1', '2', '9000']);
      expect(result.stats['2'].key_count).toBe(5);
      expect(calls).toEqual(
        expect.arrayContaining([
          ['p1', 'CLUSTER', 'SLOT-STATS', 'SLOTSRANGE', 0, 8191],
          ['p2', 'CLUSTER', 'SLOT-STATS', 'SLOTSRANGE', 8192, 16383],
        ]),
      );
      expect(calls).toHaveLength(2);
      // The unhealthy owner is reported, so its slots count as missing rather than gone.
      expect(result.failedNodes).toEqual(['10.0.0.4:6379']);
      expect(result.failedSlotRanges).toEqual([[0, 100]]);
    });

    it('does not let a slot a primary is handing off push out the slots it owns', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 99], [200, 299]] },
      ]);
      const byRange: Record<string, unknown> = {
        // Slot 150 was handed off but is still reported, at the top of the ranking.
        '0': [[1, ['key-count', 50]], [150, ['key-count', 999]]],
        '200': [[201, ['key-count', 40]]],
      };
      mockDiscoveryService.getNodeConnection.mockResolvedValue({
        call: jest.fn(async (_c: string, _s: string, _r: string, start: number) => byRange[String(start)]),
      });

      const stats = await service.getClusterSlotStats('key-count', 2);

      expect(Object.keys(stats).sort()).toEqual(['1', '201']);
    });

    it('keeps the ranges a primary answered and reports only the range that failed', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValueOnce([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 99], [200, 299]] },
      ]);
      mockDiscoveryService.getNodeConnection.mockResolvedValue({
        call: jest.fn(async (_c: string, _s: string, _r: string, start: number) => {
          if (start === 200) throw new Error('boom');
          return [[1, ['key-count', 50]]];
        }),
      });

      const result = await service.getClusterSlotStatsResult('key-count', 10);

      expect(Object.keys(result.stats)).toEqual(['1']);
      expect(result.failedNodes).toEqual(['10.0.0.1:6379']);
      expect(result.failedSlotRanges).toEqual([[200, 299]]);
    });

    it('keeps the ranges a primary answered before its deadline, even within a late batch', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValueOnce([
          { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 0], [2, 2], [4, 4]] },
        ]);
        mockDiscoveryService.getNodeConnection.mockResolvedValue({
          call: jest.fn((_c: string, _s: string, _r: string, start: number) =>
            start === 2 ? new Promise(() => undefined) : Promise.resolve([[start, ['key-count', 1]]]),
          ),
        });

        const pending = service.getClusterSlotStatsResult('key-count', 100);
        await jest.advanceTimersByTimeAsync(5_000);
        const result = await pending;

        expect(Object.keys(result.stats).sort()).toEqual(['0', '4']);
        expect(result.failedSlotRanges).toEqual([[2, 2]]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps the batches a primary finished before its deadline', async () => {
      jest.useFakeTimers();
      try {
        const slots = Array.from({ length: 17 }, (_, i): [number, number] => [i * 2, i * 2]);
        mockDiscoveryService.discoverNodes.mockResolvedValueOnce([
          { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots },
        ]);
        mockDiscoveryService.getNodeConnection.mockResolvedValue({
          call: jest.fn((_c: string, _s: string, _r: string, start: number) =>
            start === 32 ? new Promise(() => undefined) : Promise.resolve([[start, ['key-count', 1]]]),
          ),
        });

        const pending = service.getClusterSlotStatsResult('key-count', 100);
        await jest.advanceTimersByTimeAsync(5_000);
        const result = await pending;

        expect(Object.keys(result.stats)).toHaveLength(16);
        expect(result.failedNodes).toEqual(['10.0.0.1:6379']);
        expect(result.failedSlotRanges).toEqual([[32, 32]]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports a primary that does not answer in time and returns the others', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValueOnce([
          { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 8191]] },
          { id: 'p2', address: '10.0.0.3:6379', role: 'master', healthy: true, slots: [[8192, 16383]] },
        ]);
        mockDiscoveryService.getNodeConnection.mockImplementation(async (nodeId: string) => ({
          call: nodeId === 'p1'
            ? jest.fn().mockResolvedValue([[1, ['key-count', 50]]])
            : jest.fn(() => new Promise(() => undefined)),
        }));

        const pending = service.getClusterSlotStatsResult('key-count', 10);
        await jest.advanceTimersByTimeAsync(5_000);
        const result = await pending;

        expect(Object.keys(result.stats)).toEqual(['1']);
        expect(result.failedNodes).toEqual(['10.0.0.3:6379']);
        expect(result.failedSlotRanges).toEqual([[8192, 16383]]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('drops the client of a primary that did not answer, so the next call reconnects', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValue([
          { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 8191]] },
          { id: 'p2', address: '10.0.0.3:6379', role: 'master', healthy: true, slots: [[8192, 16383]] },
        ]);
        const stuckClient = { call: jest.fn(() => new Promise(() => undefined)) };
        const freshClient = { call: jest.fn().mockResolvedValue([[8192, ['key-count', 7]]]) };
        let p2Client: { call: jest.Mock } = stuckClient;
        mockDiscoveryService.getNodeConnection.mockImplementation(async (nodeId: string) =>
          nodeId === 'p1' ? { call: jest.fn().mockResolvedValue([[1, ['key-count', 50]]]) } : p2Client,
        );
        mockDiscoveryService.evictNodeClient.mockImplementation(() => {
          p2Client = freshClient;
        });

        const first = service.getClusterSlotStatsResult('key-count', 10);
        await jest.advanceTimersByTimeAsync(5_000);
        expect((await first).failedNodes).toEqual(['10.0.0.3:6379']);
        expect(mockDiscoveryService.evictNodeClient).toHaveBeenCalledWith(stuckClient);

        // The stall cleared with the eviction: the next call asks the primary again.
        const second = await service.getClusterSlotStatsResult('key-count', 10);
        expect(freshClient.call).toHaveBeenCalledTimes(1);
        expect(second.failedNodes).toEqual([]);
        expect(Object.keys(second.stats).sort()).toEqual(['1', '8192']);
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps a primary out while it has not even handed over a client', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValue([
          { id: 'p1', address: '10.0.0.1:6379', flags: ['master'], role: 'master', healthy: true, slots: [[0, 16383]] },
        ]);
        mockDiscoveryService.getNodeConnection.mockImplementation(() => new Promise(() => undefined));

        const first = service.getSlotMigrations();
        await jest.advanceTimersByTimeAsync(5_000);
        await first;
        await service.getSlotMigrations();

        expect(mockDiscoveryService.getNodeConnection).toHaveBeenCalledTimes(1);
        expect(mockDiscoveryService.evictNodeClient).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not send commands to a client that arrives after the deadline', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValue([
          { id: 'p1', address: '10.0.0.1:6379', flags: ['master'], role: 'master', healthy: true, slots: [[0, 16383]] },
        ]);
        const late = { call: jest.fn() };
        mockDiscoveryService.getNodeConnection.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(late), 7_000)),
        );

        const first = service.getSlotMigrations();
        await jest.advanceTimersByTimeAsync(5_000);
        await first;
        await jest.advanceTimersByTimeAsync(2_000);

        expect(late.call).not.toHaveBeenCalled();
        // The late client is the shared pool client and has no command from
        // this call, so it stays connected. The stall clears when the connect
        // settles, and the next call asks the node again.
        expect(mockDiscoveryService.evictNodeClient).not.toHaveBeenCalled();
        mockDiscoveryService.getNodeConnection.mockResolvedValue({ call: jest.fn().mockResolvedValue('') });
        await service.getSlotMigrations();
        expect(mockDiscoveryService.getNodeConnection).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('falls back to the connection\'s own node when no primary can be reached directly', async () => {
      // Behind an SSH tunnel the announced addresses are unreachable.
      mockDiscoveryService.discoverNodes.mockResolvedValue([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 8191]], flags: ['myself', 'master'] },
        { id: 'p2', address: '10.0.0.3:6379', role: 'master', healthy: true, slots: [[8192, 16383]], flags: ['master'] },
      ]);
      mockDiscoveryService.getNodeConnection.mockRejectedValue(new Error('connect ETIMEDOUT'));
      const getClusterSlotStats = jest.fn().mockResolvedValue({ '1': { key_count: 50 } });
      mockConnectionRegistry.get.mockReturnValue({ getClient: jest.fn(), getClusterSlotStats });

      const result = await service.getClusterSlotStatsResult('cpu-usec', 10, 'conn-1');

      expect(getClusterSlotStats).toHaveBeenCalledWith('cpu-usec', 10);
      expect(mockConnectionRegistry.get).toHaveBeenCalledWith('conn-1');
      expect(result.stats).toEqual({ '1': { key_count: 50 } });
      expect(result.failedNodes).toEqual(['10.0.0.3:6379']);
      expect(result.failedSlotRanges).toEqual([[8192, 16383]]);
    });

    it('fails with the connection\'s own error when neither a primary nor the connection answered', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValue([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] },
      ]);
      mockDiscoveryService.getNodeConnection.mockResolvedValue({ call: jest.fn().mockRejectedValue(new Error('boom')) });
      mockConnectionRegistry.get.mockReturnValue({
        getClient: jest.fn(),
        getClusterSlotStats: jest.fn().mockRejectedValue(new Error('CLUSTER SLOT-STATS not supported')),
      });

      await expect(service.getClusterSlotStats('key-count', 10)).rejects.toThrow('not supported');
    });

    it('does not drop the socket of a primary that missed a deadline the caller cut short', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValue([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] },
      ]);
      const slow = { call: jest.fn(() => new Promise(() => undefined)) };
      mockDiscoveryService.getNodeConnection.mockResolvedValue(slow);
      mockConnectionRegistry.get.mockReturnValue({ getClient: jest.fn(), getClusterSlotStats: jest.fn().mockResolvedValue({}) });

      await service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 40);

      expect(mockDiscoveryService.evictNodeClient).not.toHaveBeenCalled();
      // Its commands are still queued, so the next call does not stack more.
      await service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 40);
      expect(slow.call).toHaveBeenCalledTimes(1);
    });

    it('drops a silent primary that used up the budget a Prometheus pass actually passed', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValue([
          { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] },
        ]);
        const silent = { call: jest.fn(() => new Promise(() => undefined)) };
        mockDiscoveryService.getNodeConnection.mockResolvedValue(silent);
        mockConnectionRegistry.get.mockReturnValue({
          getClient: jest.fn(),
          getClusterSlotStats: jest.fn().mockResolvedValue({}),
        });

        // A 5s pass that spent half a second before the fan-out.
        const pending = service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 4_500, 5_000);
        await jest.advanceTimersByTimeAsync(4_500);
        await pending;

        expect(mockDiscoveryService.evictNodeClient).toHaveBeenCalledWith(silent);
      } finally {
        jest.useRealTimers();
      }
    });

    it('neither drops nor backs off a primary that missed the tail of a Prometheus pass', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValue([
          { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] },
          { id: 'p2', address: '10.0.0.2:6379', role: 'master', healthy: true, slots: [[0, 0]] },
        ]);
        const slow = { call: jest.fn(() => new Promise(() => undefined)) };
        mockDiscoveryService.getNodeConnection.mockImplementation((nodeId: string) =>
          nodeId === 'p1' ? Promise.resolve(slow) : new Promise(() => undefined),
        );
        mockConnectionRegistry.get.mockReturnValue({ getClient: jest.fn(), getClusterSlotStats: jest.fn().mockResolvedValue({}) });

        // 1.2s left of a 5s pass: each node gets 900ms, short of a real attempt.
        const first = service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 1_200, 5_000);
        await jest.advanceTimersByTimeAsync(1_200);
        await first;

        expect(mockDiscoveryService.evictNodeClient).not.toHaveBeenCalled();
        mockDiscoveryService.getNodeConnection.mockResolvedValue({ call: jest.fn().mockResolvedValue([[0, ['key-count', 5]]]) });
        const second = await service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 1_200, 5_000);
        // p2's connect was cut short, so it is asked again instead of skipped for 30s.
        const p2Connects = mockDiscoveryService.getNodeConnection.mock.calls.filter(([nodeId]) => nodeId === 'p2');
        expect(p2Connects).toHaveLength(2);
        expect(second.failedNodes).not.toContain('10.0.0.2:6379');
      } finally {
        jest.useRealTimers();
      }
    });

    it('drops a primary a short budget left stalled once a couple of full attempts have passed', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValue([
          { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] },
        ]);
        const silent = { call: jest.fn(() => new Promise(() => undefined)) };
        const fresh = { call: jest.fn().mockResolvedValue([[0, ['key-count', 5]]]) };
        let client = silent;
        mockDiscoveryService.getNodeConnection.mockImplementation(async () => client);
        mockDiscoveryService.evictNodeClient.mockImplementation(() => {
          client = fresh;
        });
        mockConnectionRegistry.get.mockReturnValue({
          getClient: jest.fn(),
          getClusterSlotStats: jest.fn().mockResolvedValue({}),
        });

        const first = service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 1_200, 5_000);
        await jest.advanceTimersByTimeAsync(1_200);
        await first;
        expect(mockDiscoveryService.evictNodeClient).not.toHaveBeenCalled();

        // Still inside the hold: a full-budget caller is turned away rather than stacking more commands.
        const connects = mockDiscoveryService.getNodeConnection.mock.calls.length;
        await service.getClusterSlotStatsResult('key-count', 10, 'conn-1');
        expect(mockDiscoveryService.getNodeConnection).toHaveBeenCalledTimes(connects);
        expect(silent.call).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(10_000);
        const again = await service.getClusterSlotStatsResult('key-count', 10, 'conn-1');
        expect(mockDiscoveryService.evictNodeClient).toHaveBeenCalledWith(silent);
        expect(fresh.call).toHaveBeenCalledTimes(1);
        expect(again.failedNodes).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('counts a slow discovery against the budget', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve([{ id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] }]),
                3_000,
              ),
            ),
        );
        mockDiscoveryService.getNodeConnection.mockResolvedValue({ call: jest.fn(() => new Promise(() => undefined)) });
        mockConnectionRegistry.get.mockReturnValue({ getClient: jest.fn(), getClusterSlotStats: jest.fn().mockResolvedValue({}) });

        let settled = false;
        const pending = service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 5_000).finally(() => {
          settled = true;
        });
        await jest.advanceTimersByTimeAsync(5_000);

        expect(settled).toBe(true);
        await expect(pending).resolves.toEqual(expect.objectContaining({ failedNodes: ['10.0.0.1:6379'] }));
      } finally {
        jest.useRealTimers();
      }
    });

    it('backs off a primary that cannot be reached within the budget a Prometheus pass passed', async () => {
      jest.useFakeTimers();
      try {
        mockDiscoveryService.discoverNodes.mockResolvedValue([
          { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] },
        ]);
        mockDiscoveryService.getNodeConnection.mockImplementation(() => new Promise(() => undefined));
        mockConnectionRegistry.get.mockReturnValue({ getClient: jest.fn(), getClusterSlotStats: jest.fn().mockResolvedValue({}) });

        const first = service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 4_500, 5_000);
        await jest.advanceTimersByTimeAsync(4_500);
        await first;
        mockDiscoveryService.getNodeConnection.mockResolvedValue({ call: jest.fn().mockResolvedValue([[1, ['key-count', 5]]]) });
        const second = await service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 4_500, 5_000);

        expect(mockDiscoveryService.getNodeConnection).toHaveBeenCalledTimes(1);
        expect(second.failedNodes).toEqual(['10.0.0.1:6379']);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not back off a primary whose connect was cut off by a shortened budget', async () => {
      mockDiscoveryService.discoverNodes.mockResolvedValue([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] },
      ]);
      mockDiscoveryService.getNodeConnection.mockImplementationOnce(() => new Promise(() => undefined));
      mockConnectionRegistry.get.mockReturnValue({ getClient: jest.fn(), getClusterSlotStats: jest.fn().mockResolvedValue({}) });

      await service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 40);
      mockDiscoveryService.getNodeConnection.mockResolvedValue({ call: jest.fn().mockResolvedValue([[1, ['key-count', 5]]]) });
      const result = await service.getClusterSlotStatsResult('key-count', 10, 'conn-1', 40);

      expect(mockDiscoveryService.getNodeConnection).toHaveBeenCalledTimes(2);
      expect(result.failedNodes).toEqual([]);
    });

    it('rejects ordering by cpu-usec while no primary reports it', async () => {
      // cluster-slot-stats-enabled no: replies carry key-count only.
      mockDiscoveryService.discoverNodes.mockResolvedValue([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 16383]] },
      ]);
      mockDiscoveryService.getNodeConnection.mockResolvedValue({
        call: jest.fn().mockResolvedValue([[1, ['key-count', 5]], [2, ['key-count', 9]]]),
      });

      await expect(service.getClusterSlotStatsResult('cpu-usec', 10, 'conn-1')).rejects.toThrow(
        'cluster-slot-stats-enabled',
      );
      await expect(service.getClusterSlotStatsResult('key-count', 10, 'conn-1')).resolves.toBeDefined();
    });

    it('warns once about a primary that keeps failing, and again after it recovered', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      mockDiscoveryService.discoverNodes.mockResolvedValue([
        { id: 'p1', address: '10.0.0.1:6379', role: 'master', healthy: true, slots: [[0, 8191]] },
        { id: 'p2', address: '10.0.0.3:6379', role: 'master', healthy: true, slots: [[8192, 16383]] },
      ]);
      let p2Up = false;
      mockDiscoveryService.getNodeConnection.mockImplementation(async (nodeId: string) =>
        nodeId === 'p2' && !p2Up
          ? Promise.reject(new Error('connect ETIMEDOUT'))
          : { call: jest.fn().mockResolvedValue([[1, ['key-count', 5]]]) },
      );
      const p2Warnings = () => warn.mock.calls.filter(([message]) => String(message).includes('10.0.0.3')).length;

      let now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const p2Attempts = () =>
        mockDiscoveryService.getNodeConnection.mock.calls.filter(([nodeId]) => nodeId === 'p2').length;

      await service.getClusterSlotStatsResult('key-count', 10, 'conn-1');
      await service.getClusterSlotStatsResult('key-count', 10, 'conn-1');
      expect(p2Warnings()).toBe(1);
      // Unreachable on its announced address: skipped until the backoff ends.
      expect(p2Attempts()).toBe(1);

      now += 31_000;
      p2Up = true;
      await service.getClusterSlotStatsResult('key-count', 10, 'conn-1');
      expect(p2Attempts()).toBe(2);
      p2Up = false;
      await service.getClusterSlotStatsResult('key-count', 10, 'conn-1');
      expect(p2Warnings()).toBe(2);
      clock.mockRestore();
      warn.mockRestore();
    });
  });
});
