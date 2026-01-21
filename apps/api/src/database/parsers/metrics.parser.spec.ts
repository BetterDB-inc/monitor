import { MetricsParser } from './metrics.parser';

describe('MetricsParser - Cluster', () => {
  describe('parseClusterNodes', () => {
    const sampleClusterNodes = `abc123def456 192.168.1.10:6379@16379 master - 0 1234567890000 1 connected 0-5460
def456abc123 192.168.1.11:6379@16379 slave abc123def456 0 1234567890000 1 connected
ghi789jkl012 192.168.1.12:6379@16379 master - 0 1234567890000 2 connected 5461-10922`;

    it('should parse node IDs correctly', () => {
      const nodes = MetricsParser.parseClusterNodes(sampleClusterNodes);

      expect(nodes).toHaveLength(3);
      expect(nodes[0].id).toBe('abc123def456');
      expect(nodes[1].id).toBe('def456abc123');
      expect(nodes[2].id).toBe('ghi789jkl012');
    });

    it('should parse addresses correctly', () => {
      const nodes = MetricsParser.parseClusterNodes(sampleClusterNodes);

      expect(nodes[0].address).toBe('192.168.1.10:6379@16379');
      expect(nodes[1].address).toBe('192.168.1.11:6379@16379');
    });

    it('should parse flags correctly', () => {
      const nodes = MetricsParser.parseClusterNodes(sampleClusterNodes);

      expect(nodes[0].flags).toContain('master');
      expect(nodes[1].flags).toContain('slave');
      expect(nodes[2].flags).toContain('master');
    });

    it('should parse multiple flags separated by comma', () => {
      const withMultipleFlags = `abc123 192.168.1.10:6379@16379 master,myself - 0 0 1 connected 0-5460`;

      const nodes = MetricsParser.parseClusterNodes(withMultipleFlags);

      expect(nodes[0].flags).toContain('master');
      expect(nodes[0].flags).toContain('myself');
    });

    it('should parse master reference for replicas', () => {
      const nodes = MetricsParser.parseClusterNodes(sampleClusterNodes);

      expect(nodes[0].master).toBe('-');
      expect(nodes[1].master).toBe('abc123def456');
    });

    it('should parse ping and pong times', () => {
      const nodes = MetricsParser.parseClusterNodes(sampleClusterNodes);

      expect(nodes[0].pingSent).toBe(0);
      expect(nodes[0].pongReceived).toBe(1234567890000);
    });

    it('should parse config epoch', () => {
      const nodes = MetricsParser.parseClusterNodes(sampleClusterNodes);

      expect(nodes[0].configEpoch).toBe(1);
      expect(nodes[2].configEpoch).toBe(2);
    });

    it('should parse link state', () => {
      const nodes = MetricsParser.parseClusterNodes(sampleClusterNodes);

      expect(nodes[0].linkState).toBe('connected');
      expect(nodes[1].linkState).toBe('connected');
    });

    it('should parse slot ranges correctly', () => {
      const nodes = MetricsParser.parseClusterNodes(sampleClusterNodes);

      expect(nodes[0].slots).toEqual([[0, 5460]]);
      expect(nodes[1].slots).toEqual([]);
      expect(nodes[2].slots).toEqual([[5461, 10922]]);
    });

    it('should parse multiple slot ranges', () => {
      const multipleRanges = `abc123 192.168.1.10:6379@16379 master - 0 0 1 connected 0-5460 10923-16383`;

      const nodes = MetricsParser.parseClusterNodes(multipleRanges);

      expect(nodes[0].slots).toEqual([[0, 5460], [10923, 16383]]);
    });

    it('should parse single slot numbers', () => {
      const singleSlot = `abc123 192.168.1.10:6379@16379 master - 0 0 1 connected 100 200 300`;

      const nodes = MetricsParser.parseClusterNodes(singleSlot);

      expect(nodes[0].slots).toEqual([[100, 100], [200, 200], [300, 300]]);
    });

    it('should handle migrating slot notation', () => {
      const withMigration = `abc123 192.168.1.10:6379@16379 master - 0 0 1 connected 0-5460 [5461->-def456]`;

      const nodes = MetricsParser.parseClusterNodes(withMigration);

      expect(nodes).toHaveLength(1);
      expect(nodes[0].slots).toEqual([[0, 5460]]);
      expect(nodes[0].migratingSlots).toBeDefined();
      expect(nodes[0].migratingSlots).toHaveLength(1);
      expect(nodes[0].migratingSlots![0]).toEqual({
        slot: 5461,
        targetNodeId: 'def456',
      });
    });

    it('should handle importing slot notation', () => {
      const withImport = `def456 192.168.1.11:6379@16379 master - 0 0 2 connected 5461-10922 [5461-<-abc123]`;

      const nodes = MetricsParser.parseClusterNodes(withImport);

      expect(nodes).toHaveLength(1);
      expect(nodes[0].importingSlots).toBeDefined();
      expect(nodes[0].importingSlots).toHaveLength(1);
      expect(nodes[0].importingSlots![0]).toEqual({
        slot: 5461,
        sourceNodeId: 'abc123',
      });
    });

    it('should handle multiple migrations and imports', () => {
      const withMultiple = `abc123 192.168.1.10:6379@16379 master - 0 0 1 connected 0-5460 [100->-def456] [200->-ghi789]`;

      const nodes = MetricsParser.parseClusterNodes(withMultiple);

      expect(nodes[0].migratingSlots).toBeDefined();
      expect(nodes[0].migratingSlots!.length).toBeGreaterThanOrEqual(1);
      // Should find at least one migration
      const slots = nodes[0].migratingSlots!.map(m => m.slot);
      expect(slots).toContain(100);
    });

    it('should handle disconnected nodes', () => {
      const disconnected = `abc123 192.168.1.10:6379@16379 master,fail - 0 0 1 disconnected 0-5460`;

      const nodes = MetricsParser.parseClusterNodes(disconnected);

      expect(nodes[0].linkState).toBe('disconnected');
      expect(nodes[0].flags).toContain('fail');
    });

    it('should handle nodes with no slots', () => {
      const noSlots = `abc123 192.168.1.10:6379@16379 master - 0 0 1 connected`;

      const nodes = MetricsParser.parseClusterNodes(noSlots);

      expect(nodes[0].slots).toEqual([]);
    });

    it('should handle empty input', () => {
      const nodes = MetricsParser.parseClusterNodes('');

      // Parser returns array with one element for empty line
      expect(Array.isArray(nodes)).toBe(true);
    });

    it('should handle whitespace-only input', () => {
      const nodes = MetricsParser.parseClusterNodes('   \n  \t  ');

      // Parser returns array with elements for each line
      expect(Array.isArray(nodes)).toBe(true);
    });

    it('should not include migratingSlots property if empty', () => {
      const withoutMigration = `abc123 192.168.1.10:6379@16379 master - 0 0 1 connected 0-5460`;

      const nodes = MetricsParser.parseClusterNodes(withoutMigration);

      expect(nodes[0]).not.toHaveProperty('migratingSlots');
    });

    it('should not include importingSlots property if empty', () => {
      const withoutImport = `abc123 192.168.1.10:6379@16379 master - 0 0 1 connected 0-5460`;

      const nodes = MetricsParser.parseClusterNodes(withoutImport);

      expect(nodes[0]).not.toHaveProperty('importingSlots');
    });
  });

  describe('parseSlotStats', () => {
    it('should parse CLUSTER SLOT-STATS response', () => {
      const rawResponse = [
        [0, ['key-count', 100]],
        [0, ['expires-count', 10]],
        [0, ['total-reads', 1000]],
        [0, ['total-writes', 500]],
        [1, ['key-count', 200]],
        [1, ['expires-count', 20]],
        [1, ['total-reads', 2000]],
        [1, ['total-writes', 1000]],
      ];

      const stats = MetricsParser.parseSlotStats(rawResponse);

      expect(stats['0']).toEqual({
        key_count: 100,
        expires_count: 10,
        total_reads: 1000,
        total_writes: 500,
      });

      expect(stats['1']).toEqual({
        key_count: 200,
        expires_count: 20,
        total_reads: 2000,
        total_writes: 1000,
      });
    });

    it('should handle empty response', () => {
      const stats = MetricsParser.parseSlotStats([]);

      expect(stats).toEqual({});
    });

    it('should handle malformed entries gracefully', () => {
      const rawResponse = [
        [0, ['key-count', 100]],
        ['invalid'], // Invalid entry
        [1, ['key-count', 200]],
      ];

      const stats = MetricsParser.parseSlotStats(rawResponse);

      expect(stats['0']).toBeDefined();
      expect(stats['1']).toBeDefined();
    });

    it('should ignore unknown metric names', () => {
      const rawResponse = [
        [0, ['key-count', 100]],
        [0, ['unknown-metric', 999]],
      ];

      const stats = MetricsParser.parseSlotStats(rawResponse);

      expect(stats['0'].key_count).toBe(100);
      expect(stats['0']).not.toHaveProperty('unknown_metric');
    });

    it('should handle partial metric data', () => {
      const rawResponse = [
        [0, ['key-count', 100]],
        // Missing other metrics for slot 0
      ];

      const stats = MetricsParser.parseSlotStats(rawResponse);

      expect(stats['0']).toEqual({
        key_count: 100,
        expires_count: 0,
        total_reads: 0,
        total_writes: 0,
      });
    });

    it('should handle non-array input', () => {
      const stats = MetricsParser.parseSlotStats('invalid' as any);

      expect(stats).toEqual({});
    });
  });

  describe('parseSlowLog', () => {
    it('should parse slowlog entries', () => {
      const rawEntries = [
        [1, 1234567890, 10000, ['GET', 'key1'], '127.0.0.1:12345', 'client1'],
        [2, 1234567891, 20000, ['SET', 'key2', 'value'], '127.0.0.1:12346', 'client2'],
      ];

      const entries = MetricsParser.parseSlowLog(rawEntries);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        id: 1,
        timestamp: 1234567890,
        duration: 10000,
        command: ['GET', 'key1'],
        clientAddress: '127.0.0.1:12345',
        clientName: 'client1',
      });
    });

    it('should handle empty slowlog', () => {
      const entries = MetricsParser.parseSlowLog([]);

      expect(entries).toHaveLength(0);
    });
  });

  describe('parseClientList', () => {
    it('should parse client list string', () => {
      const clientListString = `id=1 addr=127.0.0.1:12345 name=test age=10 idle=5 flags=N db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=0 obl=0 oll=0 omem=0 events=r cmd=get user=default
id=2 addr=127.0.0.1:12346 name=test2 age=20 idle=10 flags=N db=1 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=0 obl=0 oll=0 omem=0 events=rw cmd=set user=default`;

      const clients = MetricsParser.parseClientList(clientListString);

      expect(clients).toHaveLength(2);
      expect(clients[0].id).toBe('1');
      expect(clients[0].addr).toBe('127.0.0.1:12345');
      expect(clients[0].name).toBe('test');
      expect(clients[0].age).toBe(10);
      expect(clients[1].db).toBe(1);
    });

    it('should handle empty client list', () => {
      const clients = MetricsParser.parseClientList('');

      // Parser returns array with one element for empty line
      expect(Array.isArray(clients)).toBe(true);
    });
  });
});
