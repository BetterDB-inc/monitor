import type { ClusterNode, SentinelNodeInfo } from '@app/common/types/metrics.types';
import {
  TOPOLOGY_TARGET_LIMIT,
  clusterTargets,
  connectionOfStateKey,
  isTopologyStateKeyOf,
  sentinelTargets,
  splitHostPort,
  topologyStateKey,
} from '../topology-targets';

const nothingRegistered = () => false;

function clusterNode(id: string, address: string, flags: string[]): ClusterNode {
  return {
    id,
    address,
    flags,
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 0,
    linkState: 'connected',
    slots: [],
  };
}

function sentinelMaster(name: string, ip: string, port: number, flags = ['master']): SentinelNodeInfo {
  return { name, ip, port, runid: 'r', flags, fields: {} } as SentinelNodeInfo;
}

describe('topology targets', () => {
  describe('clusterTargets', () => {
    it('picks the other reachable primaries', () => {
      const targets = clusterTargets(
        [
          clusterNode('a', '10.0.0.1:6379@16379', ['myself', 'master']),
          clusterNode('b', '10.0.0.2:6379@16379,node-b', ['master']),
          clusterNode('c', '10.0.0.3:6379@16379', ['slave']),
          clusterNode('d', '10.0.0.4:6379@16379', ['master', 'fail']),
          clusterNode('e', ':0@0', ['master', 'noaddr']),
        ],
        nothingRegistered,
      );

      expect(targets).toEqual([{ addr: '10.0.0.2:6379', host: '10.0.0.2', port: 6379, nodeId: 'b' }]);
    });

    it('skips primaries that are monitored as their own connection', () => {
      const targets = clusterTargets(
        [clusterNode('b', '10.0.0.2:6379@16379', ['master'])],
        (host, port) => host === '10.0.0.2' && port === 6379,
      );

      expect(targets).toEqual([]);
    });

    it('caps the fan-out', () => {
      const nodes = Array.from({ length: TOPOLOGY_TARGET_LIMIT + 5 }, (_, i) =>
        clusterNode(`n${i}`, `10.0.1.${i}:6379@16379`, ['master']),
      );

      expect(clusterTargets(nodes, nothingRegistered)).toHaveLength(TOPOLOGY_TARGET_LIMIT);
    });
  });

  describe('sentinelTargets', () => {
    it('picks each monitored primary once and skips down ones', () => {
      const targets = sentinelTargets(
        [
          sentinelMaster('alpha', '10.0.0.2', 6379),
          sentinelMaster('alpha-dup', '10.0.0.2', 6379),
          sentinelMaster('beta', '10.0.0.3', 6379, ['master', 's_down']),
          sentinelMaster('gamma', '10.0.0.4', 6380),
        ],
        nothingRegistered,
      );

      expect(targets.map((t) => t.addr)).toEqual(['10.0.0.2:6379', '10.0.0.4:6380']);
      expect(targets[0].nodeId).toBeUndefined();
    });
  });

  describe('state keys', () => {
    it('round-trips the connection id', () => {
      const key = topologyStateKey('conn-1', '10.0.0.2:6379');

      expect(connectionOfStateKey(key)).toBe('conn-1');
      expect(connectionOfStateKey('conn-1')).toBe('conn-1');
      expect(isTopologyStateKeyOf(key, 'conn-1')).toBe(true);
      expect(isTopologyStateKeyOf('conn-1', 'conn-1')).toBe(true);
      expect(isTopologyStateKeyOf('conn-10', 'conn-1')).toBe(false);
    });
  });

  describe('splitHostPort', () => {
    it('reads IPv6 and bus-port addresses', () => {
      expect(splitHostPort('[::1]:6379@16379')).toEqual({ host: '::1', port: 6379 });
      expect(splitHostPort('host:notaport')).toBeNull();
    });
  });
});
