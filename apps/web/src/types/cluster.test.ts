import { describe, it, expect } from 'vitest';
import {
  formatSlotRanges,
  countSlots,
  buildSlotNodeMap,
  CLUSTER_TOTAL_SLOTS,
  CLUSTER_GRID_SIZE,
} from './cluster';
import type { ClusterNode } from './metrics';

describe('Cluster Utility Functions', () => {
  describe('formatSlotRanges', () => {
    it('should format single slot', () => {
      expect(formatSlotRanges([[5461, 5461]])).toBe('5461');
    });

    it('should format slot range', () => {
      expect(formatSlotRanges([[0, 5460]])).toBe('0-5460');
    });

    it('should format multiple ranges', () => {
      expect(formatSlotRanges([[0, 5460], [10923, 16383]])).toBe('0-5460, 10923-16383');
    });

    it('should format mixed single slots and ranges', () => {
      expect(formatSlotRanges([[0, 5460], [5461, 5461], [10923, 16383]])).toBe('0-5460, 5461, 10923-16383');
    });

    it('should handle empty array', () => {
      expect(formatSlotRanges([])).toBe('');
    });

    it('should handle single element range', () => {
      expect(formatSlotRanges([[100, 100]])).toBe('100');
    });
  });

  describe('countSlots', () => {
    it('should count slots in single range', () => {
      expect(countSlots([[0, 5460]])).toBe(5461);
    });

    it('should count slots in multiple ranges', () => {
      expect(countSlots([[0, 5460], [5461, 10922]])).toBe(10923);
    });

    it('should handle single slot', () => {
      expect(countSlots([[100, 100]])).toBe(1);
    });

    it('should return 0 for empty array', () => {
      expect(countSlots([])).toBe(0);
    });

    it('should count all slots correctly', () => {
      expect(countSlots([[0, 16383]])).toBe(CLUSTER_TOTAL_SLOTS);
    });

    it('should count multiple single slots', () => {
      expect(countSlots([[100, 100], [200, 200], [300, 300]])).toBe(3);
    });

    it('should count mixed ranges and single slots', () => {
      expect(countSlots([[0, 5460], [5461, 5461], [5462, 10922]])).toBe(10923);
    });
  });

  describe('buildSlotNodeMap', () => {
    const mockNodes: ClusterNode[] = [
      {
        id: 'node1',
        address: '192.168.1.10:6379',
        flags: ['master'],
        master: '-',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [[0, 5460]],
      },
      {
        id: 'node2',
        address: '192.168.1.11:6379',
        flags: ['master'],
        master: '-',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 2,
        linkState: 'connected',
        slots: [[5461, 10922]],
      },
      {
        id: 'node3',
        address: '192.168.1.12:6379',
        flags: ['slave'],
        master: 'node1',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [],
      },
    ];

    it('should map slots to master nodes', () => {
      const map = buildSlotNodeMap(mockNodes);

      expect(map.get(0)).toBe('node1');
      expect(map.get(5460)).toBe('node1');
      expect(map.get(5461)).toBe('node2');
      expect(map.get(10922)).toBe('node2');
    });

    it('should not include replica nodes', () => {
      const map = buildSlotNodeMap(mockNodes);
      const values = Array.from(map.values());

      expect(values).not.toContain('node3');
    });

    it('should handle empty nodes array', () => {
      const map = buildSlotNodeMap([]);
      expect(map.size).toBe(0);
    });

    it('should handle nodes with no slots', () => {
      const nodesWithoutSlots: ClusterNode[] = [
        {
          id: 'node1',
          address: '192.168.1.10:6379',
          flags: ['master'],
          master: '-',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [],
        },
      ];

      const map = buildSlotNodeMap(nodesWithoutSlots);
      expect(map.size).toBe(0);
    });

    it('should handle single slot assignments', () => {
      const singleSlotNodes: ClusterNode[] = [
        {
          id: 'node1',
          address: '192.168.1.10:6379',
          flags: ['master'],
          master: '-',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [[100, 100], [200, 200]],
        },
      ];

      const map = buildSlotNodeMap(singleSlotNodes);
      expect(map.get(100)).toBe('node1');
      expect(map.get(200)).toBe('node1');
      expect(map.size).toBe(2);
    });

    it('should map all slots in a full cluster', () => {
      const fullClusterNodes: ClusterNode[] = [
        {
          id: 'node1',
          address: '192.168.1.10:6379',
          flags: ['master'],
          master: '-',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [[0, 5460]],
        },
        {
          id: 'node2',
          address: '192.168.1.11:6379',
          flags: ['master'],
          master: '-',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 2,
          linkState: 'connected',
          slots: [[5461, 10922]],
        },
        {
          id: 'node3',
          address: '192.168.1.12:6379',
          flags: ['master'],
          master: '-',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 3,
          linkState: 'connected',
          slots: [[10923, 16383]],
        },
      ];

      const map = buildSlotNodeMap(fullClusterNodes);
      expect(map.size).toBe(CLUSTER_TOTAL_SLOTS);
    });
  });

  describe('Constants', () => {
    it('should have correct total slots', () => {
      expect(CLUSTER_TOTAL_SLOTS).toBe(16384);
    });

    it('should have correct grid size', () => {
      expect(CLUSTER_GRID_SIZE).toBe(128);
      expect(CLUSTER_GRID_SIZE * CLUSTER_GRID_SIZE).toBe(CLUSTER_TOTAL_SLOTS);
    });
  });
});
