import type { ClusterNode, SentinelNodeInfo } from '@app/common/types/metrics.types';
import {
  TOPOLOGY_TARGET_LIMIT,
  TopologyTargetClaims,
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
      const { targets, members } = clusterTargets(
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
      expect([...members].sort()).toEqual(['10.0.0.2:6379', '10.0.0.4:6379']);
    });

    it('reads a primary once when two node ids share its address', () => {
      const { targets } = clusterTargets(
        [
          clusterNode('b', '10.0.0.2:6379@16379', ['master']),
          clusterNode('b2', '10.0.0.2:6379@16379', ['master']),
        ],
        nothingRegistered,
      );

      expect(targets.map((t) => t.nodeId)).toEqual(['b']);
    });

    it('skips primaries that are monitored as their own connection', () => {
      const { targets, members } = clusterTargets(
        [clusterNode('b', '10.0.0.2:6379@16379', ['master'])],
        (host, port) => host === '10.0.0.2' && port === 6379,
      );

      expect(targets).toEqual([]);
      expect(members.size).toBe(0);
    });

    it('skips primaries registered by cluster node id', () => {
      const { targets, members } = clusterTargets(
        [clusterNode('b', '10.0.0.2:6379@16379', ['master'])],
        (_host, _port, nodeId) => nodeId === 'b',
      );

      expect(targets).toEqual([]);
      expect(members.size).toBe(0);
    });

    it('leaves the cap to the claims so other connections can take the rest', () => {
      const nodes = Array.from({ length: TOPOLOGY_TARGET_LIMIT + 5 }, (_, i) =>
        clusterNode(`n${i}`, `10.0.1.${i}:6379@16379`, ['master']),
      );
      const { targets } = clusterTargets(nodes, nothingRegistered);
      const claims = new TopologyTargetClaims();

      const first = claims.claim('conn-a', targets, 0, 30_000);
      const second = claims.claim('conn-b', targets, 0, 30_000);

      expect(targets).toHaveLength(TOPOLOGY_TARGET_LIMIT + 5);
      expect(first).toHaveLength(TOPOLOGY_TARGET_LIMIT);
      expect(second.map((t) => t.addr)).toEqual(
        targets.filter((t) => !first.includes(t)).map((t) => t.addr),
      );
    });
  });

  describe('sentinelTargets', () => {
    it('picks each monitored primary once and skips down ones', () => {
      const { targets, members } = sentinelTargets(
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
      expect(members.has('10.0.0.3:6379')).toBe(true);
    });
  });

  describe('TopologyTargetClaims', () => {
    const target = { addr: '10.0.0.9:6379', host: '10.0.0.9', port: 6379 };

    it('leaves a primary to the first connection that reaches it', () => {
      const claims = new TopologyTargetClaims();

      expect(claims.claim('a', [target], 0, 30_000)).toEqual([target]);
      expect(claims.claim('b', [target], 1_000, 30_000)).toEqual([]);
      expect(claims.claim('a', [target], 2_000, 30_000)).toEqual([target]);
    });

    it('lets a connection that reaches a primary take it over from one holding it as down', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [], 0, 30_000, TOPOLOGY_TARGET_LIMIT, [target.addr]);
      expect(claims.heldByOther('b', target.addr, 1_000, 30_000)).toBe(true);

      expect(claims.claim('b', [target], 1_000, 30_000)).toEqual([target]);
      // The down claim stays until b has read the primary.
      expect(claims.heldByOther('b', target.addr, 1_000, 30_000)).toBe(true);
      claims.confirm('b', target.addr, 1_000);

      expect(claims.heldByOther('a', target.addr, 2_000, 30_000)).toBe(true);
      // A down claim never takes a primary back from the connection reading it.
      claims.claim('a', [], 2_000, 30_000, TOPOLOGY_TARGET_LIMIT, [target.addr]);
      expect(claims.heldByOther('a', target.addr, 3_000, 30_000)).toBe(true);
      expect(claims.heldByOther('b', target.addr, 3_000, 30_000)).toBe(false);
    });

    it('keeps the down claim when the takeover read fails', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [], 0, 30_000, TOPOLOGY_TARGET_LIMIT, [target.addr]);

      claims.claim('b', [target], 1_000, 30_000);
      claims.releaseTarget('b', target.addr);

      expect(claims.heldByOther('b', target.addr, 2_000, 30_000)).toBe(true);
      expect(claims.heldByOther('a', target.addr, 2_000, 30_000)).toBe(false);
    });

    it('lets one connection at a time take over a down-held primary', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [], 0, 30_000, TOPOLOGY_TARGET_LIMIT, [target.addr]);

      expect(claims.claim('b', [target], 1_000, 30_000)).toEqual([target]);
      expect(claims.isFreeFor('c', target.addr, 1_000, 30_000)).toBe(false);
      expect(claims.claim('c', [target], 1_000, 30_000)).toEqual([]);
      // The down holder refreshing its claim keeps the reservation.
      claims.claim('a', [], 2_000, 30_000, TOPOLOGY_TARGET_LIMIT, [target.addr]);
      expect(claims.claim('c', [target], 2_000, 30_000)).toEqual([]);
      // Only the reserving connection can confirm.
      expect(claims.confirm('c', target.addr, 2_000)).toBe(false);
      expect(claims.heldByOther('b', target.addr, 2_000, 30_000)).toBe(true);
      expect(claims.heldByOther('c', target.addr, 2_000, 30_000)).toBe(true);

      claims.releaseTarget('b', target.addr);
      expect(claims.claim('c', [target], 3_000, 30_000)).toEqual([target]);
      expect(claims.heldByOther('c', target.addr, 3_000, 30_000)).toBe(true);
    });

    it('refuses the confirmation once the down holder claims the primary as reachable again', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [], 0, 30_000, TOPOLOGY_TARGET_LIMIT, [target.addr]);
      claims.claim('b', [target], 1_000, 30_000);

      claims.claim('a', [target], 2_000, 30_000);

      expect(claims.confirm('b', target.addr, 2_000)).toBe(false);
      expect(claims.heldByOther('b', target.addr, 2_000, 30_000)).toBe(true);
    });

    it('frees a takeover when the reserving connection stops claiming it or is removed', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [], 0, 30_000, TOPOLOGY_TARGET_LIMIT, [target.addr]);

      claims.claim('b', [target], 1_000, 30_000);
      claims.claim('b', [], 2_000, 30_000);
      expect(claims.isFreeFor('c', target.addr, 2_000, 30_000)).toBe(true);

      claims.claim('b', [target], 3_000, 30_000);
      claims.release('b');
      expect(claims.isFreeFor('c', target.addr, 3_000, 30_000)).toBe(true);
      expect(claims.heldByOther('c', target.addr, 3_000, 30_000)).toBe(true);
    });

    it('treats a primary held only as down as free', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [], 0, 30_000, TOPOLOGY_TARGET_LIMIT, [target.addr]);

      expect(claims.isFreeFor('b', target.addr, 1_000, 30_000)).toBe(true);
      claims.claim('a', [target], 2_000, 30_000);
      expect(claims.isFreeFor('b', target.addr, 3_000, 30_000)).toBe(false);
    });

    it('hands a primary over once its owner gives it up', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [target], 0, 30_000);

      expect(claims.heldByOther('b', target.addr, 1_000, 30_000)).toBe(true);
      claims.releaseTarget('a', target.addr);

      expect(claims.heldByOther('b', target.addr, 1_000, 30_000)).toBe(false);
      expect(claims.claim('b', [target], 1_000, 30_000)).toEqual([target]);
    });

    it('hands a primary over when its owner stops claiming it', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [target], 0, 30_000);

      expect(claims.claim('b', [target], 31_000, 30_000)).toEqual([target]);
      claims.claim('a', [], 32_000, 30_000);
      expect(claims.claim('b', [target], 33_000, 30_000)).toEqual([target]);
    });

    it('frees the primaries of a removed connection', () => {
      const claims = new TopologyTargetClaims();
      claims.claim('a', [target], 0, 30_000);
      claims.release('a');

      expect(claims.claim('b', [target], 1_000, 30_000)).toEqual([target]);
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
