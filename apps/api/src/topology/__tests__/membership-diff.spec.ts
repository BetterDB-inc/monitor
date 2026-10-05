import type { TopologyMembership } from '@betterdb/shared';
import type { DiscoveredNode } from '../../cluster/cluster-discovery.service';
import {
  AddressOwner,
  MemberSnapshot,
  desiredFromDiscovery,
  diffMembership,
  exceedsRetirementThreshold,
  parseNodeAddress,
  retirementKey,
} from '../membership-diff';

function node(id: string, address: string, flags: string[] = ['master']): DiscoveredNode {
  return { id, address, flags, role: 'master', slots: [], configEpoch: 0, healthy: true };
}

function member(id: string, address: string, membership: Partial<TopologyMembership> = {}): MemberSnapshot {
  const [host, port] = address.split(':');
  return { id, host, port: Number(port), membership: { seedId: 'seed', nodeId: id, origin: 'auto', source: 'cluster', ...membership } };
}

const none = () => null;

describe('parseNodeAddress', () => {
  it.each([
    ['10.0.0.1:7001@17001', { host: '10.0.0.1', port: 7001 }],
    ['10.0.0.1:7001', { host: '10.0.0.1', port: 7001 }],
    ['[::1]:7001@17001', { host: '::1', port: 7001 }],
    [':0@0', null],
    ['garbage', null],
  ])('parses %s', (address, expected) => {
    expect(parseNodeAddress(address)).toEqual(expected);
  });
});

describe('desiredFromDiscovery', () => {
  it('drops the seed, myself, noaddr and handshake nodes', () => {
    const desired = desiredFromDiscovery({ host: 'SEED.local', port: 7001 }, [
      node('a', 'seed.local:7001@17001'),
      node('b', '127.0.0.1:7001@17001', ['myself', 'master']),
      node('c', ':0@0', ['master', 'noaddr']),
      node('d', '10.0.0.4:7004@17004', ['handshake']),
      node('e', '10.0.0.5:7005@17005', ['slave']),
    ]);
    expect(desired).toEqual([{ host: '10.0.0.5', port: 7005, nodeId: 'e', source: 'cluster' }]);
  });

  it('carries the hostname a node announces', () => {
    const desired = desiredFromDiscovery({ host: 'seed', port: 7001 }, [
      { ...node('a', '10.0.0.2:7002@17002'), hostname: 'node-2.cluster.local' },
      node('b', '10.0.0.3:7003@17003'),
    ]);
    expect(desired).toEqual([
      { host: '10.0.0.2', port: 7002, nodeId: 'a', source: 'cluster', hostname: 'node-2.cluster.local' },
      { host: '10.0.0.3', port: 7003, nodeId: 'b', source: 'cluster' },
    ]);
  });

  it('stamps cluster source in desiredFromDiscovery', () => {
    const nodes = [{ id: 'n2', address: '10.0.0.2:7002@17002', flags: ['master'], role: 'master', slots: [], configEpoch: 0, healthy: true }];
    expect(desiredFromDiscovery({ host: 'seed', port: 7001 }, nodes as never)[0].source).toBe('cluster');
  });
});

describe('diffMembership', () => {
  it('adds unknown addresses', () => {
    const desiredNode = { host: '10.0.0.2', port: 7002, nodeId: 'n2', source: 'cluster' as const };
    const diff = diffMembership('seed', [desiredNode], [], none);
    expect(diff.add).toEqual([desiredNode]);
  });

  it('refreshes the node id when a node is replaced at the same address', () => {
    const desiredNode = { host: '10.0.0.2', port: 7002, nodeId: 'new', source: 'cluster' as const };
    const diff = diffMembership('seed', [desiredNode], [member('c2', '10.0.0.2:7002', { nodeId: 'old' })], none);
    expect(diff.refresh).toEqual([{ id: 'c2', node: desiredNode }]);
    expect(diff.add).toEqual([]);
  });

  it('refreshes a member whose announced hostname appeared, changed or went away', () => {
    const bare = { host: '10.0.0.2', port: 7002, nodeId: 'c2', source: 'cluster' as const };
    const named = { ...bare, hostname: 'node-2.cluster.local' };
    expect(diffMembership('seed', [named], [member('c2', '10.0.0.2:7002')], none).refresh).toEqual([{ id: 'c2', node: named }]);
    expect(diffMembership('seed', [named], [member('c2', '10.0.0.2:7002', { hostname: 'old.cluster.local' })], none).refresh).toEqual([{ id: 'c2', node: named }]);
    expect(diffMembership('seed', [bare], [member('c2', '10.0.0.2:7002', { hostname: 'node-2.cluster.local' })], none).refresh).toEqual([{ id: 'c2', node: bare }]);
  });

  it('does not refresh a member whose announced hostname is unchanged', () => {
    const named = { host: '10.0.0.2', port: 7002, nodeId: 'c2', source: 'cluster' as const, hostname: 'node-2.cluster.local' };
    const diff = diffMembership('seed', [named], [member('c2', '10.0.0.2:7002', { hostname: 'node-2.cluster.local' })], none);
    expect(diff).toMatchObject({ add: [], retire: [], refresh: [] });
  });

  it('matches addresses case-insensitively', () => {
    const diff = diffMembership('seed', [{ host: 'Node-2.local', port: 7002, nodeId: 'c2', source: 'cluster' }], [member('c2', 'node-2.local:7002')], none);
    expect(diff).toMatchObject({ add: [], retire: [], refresh: [] });
  });

  it('retires active members that left, but not already-retired ones', () => {
    const diff = diffMembership('seed', [], [member('gone', '10.0.0.3:7003'), member('old', '10.0.0.4:7004', { retiredAt: 1 })], none);
    expect(diff.retire).toEqual(['gone']);
  });

  it('retires adopted members that left', () => {
    const diff = diffMembership('seed', [], [member('mine', '10.0.0.3:7003', { origin: 'adopted' })], none);
    expect(diff.retire).toEqual(['mine']);
  });

  it('reactivates a retired member that rejoined', () => {
    const desiredNode = { host: '10.0.0.3', port: 7003, nodeId: 'n3', source: 'cluster' as const };
    const diff = diffMembership('seed', [desiredNode], [member('c3', '10.0.0.3:7003', { retiredAt: 1 })], none);
    expect(diff.reactivate).toEqual([{ id: 'c3', node: desiredNode }]);
  });

  it('skips reactivation when another connection took the address', () => {
    const owner: AddressOwner = { id: 'otlp', connectionType: 'external' };
    const diff = diffMembership('seed', [{ host: '10.0.0.3', port: 7003, nodeId: 'n3', source: 'cluster' }], [member('c3', '10.0.0.3:7003', { retiredAt: 1 })], () => owner);
    expect(diff.reactivate).toEqual([]);
    expect(diff.skipped).toEqual([{ host: '10.0.0.3', port: 7003, reason: 'occupied' }]);
  });

  it('adopts an unclaimed direct connection at a discovered address', () => {
    const owner: AddressOwner = { id: 'manual', connectionType: 'direct' };
    const desiredNode = { host: '10.0.0.3', port: 7003, nodeId: 'n3', source: 'cluster' as const };
    const diff = diffMembership('seed', [desiredNode], [], () => owner);
    expect(diff.adopt).toEqual([{ id: 'manual', node: desiredNode }]);
  });

  it('never adopts a connection that is itself a seed', () => {
    const owner: AddressOwner = { id: 'other-seed', connectionType: 'direct', isSeed: true };
    const diff = diffMembership('seed', [{ host: '10.0.0.3', port: 7003, nodeId: 'n3', source: 'cluster' }], [], () => owner);
    expect(diff.adopt).toEqual([]);
    expect(diff.add).toEqual([]);
    expect(diff.skipped).toEqual([{ host: '10.0.0.3', port: 7003, reason: 'seed' }]);
  });

  it('skips addresses claimed by another seed or pushed over OTLP', () => {
    const lookup = (host: string): AddressOwner =>
      host === '10.0.0.3'
        ? { id: 'x', connectionType: 'direct', membership: { seedId: 'other', nodeId: 'n3', origin: 'auto', source: 'cluster' } }
        : { id: 'y', connectionType: 'external' };
    const diff = diffMembership('seed', [
      { host: '10.0.0.3', port: 7003, nodeId: 'n3', source: 'cluster' },
      { host: '10.0.0.4', port: 7004, nodeId: 'n4', source: 'cluster' },
    ], [], lookup);
    expect(diff.skipped).toEqual([
      { host: '10.0.0.3', port: 7003, reason: 'claimed' },
      { host: '10.0.0.4', port: 7004, reason: 'external' },
    ]);
    expect(diff.add).toEqual([]);
  });

  const sentinelNode = (host: string, port: number, role: 'primary' | 'replica', nodeId = `${host}`) =>
    ({ host, port, nodeId, source: 'sentinel' as const, group: 'mymaster', role });

  it('refreshes a member whose role changed', () => {
    const current = [{ id: 'a', host: '10.0.0.1', port: 6379, membership: { seedId: 'seed', nodeId: '10.0.0.1', origin: 'auto' as const, source: 'sentinel' as const, group: 'mymaster', role: 'primary' as const } }];
    const diff = diffMembership('seed', [sentinelNode('10.0.0.1', 6379, 'replica')], current, () => null);
    expect(diff.refresh).toEqual([{ id: 'a', node: sentinelNode('10.0.0.1', 6379, 'replica') }]);
    expect(diff.retire).toEqual([]);
  });

  it('refreshes a member whose source changed', () => {
    const current = [{ id: 'a', host: 'h', port: 1, membership: { seedId: 'seed', nodeId: 'h', origin: 'auto' as const, source: 'cluster' as const, group: 'mymaster', role: 'replica' as const } }];
    const diff = diffMembership('seed', [sentinelNode('h', 1, 'replica')], current, () => null);
    expect(diff.refresh).toEqual([{ id: 'a', node: sentinelNode('h', 1, 'replica') }]);
  });

  it('refreshes a member whose group changed', () => {
    const current = [{ id: 'a', host: 'h', port: 1, membership: { seedId: 'seed', nodeId: 'h', origin: 'auto' as const, source: 'sentinel' as const, group: 'old', role: 'replica' as const } }];
    const diff = diffMembership('seed', [sentinelNode('h', 1, 'replica')], current, () => null);
    expect(diff.refresh).toHaveLength(1);
  });

  it('does not refresh an unchanged cluster member', () => {
    const current = [{ id: 'a', host: 'h', port: 1, membership: { seedId: 'seed', nodeId: 'n1', origin: 'auto' as const, source: 'cluster' as const } }];
    const diff = diffMembership('seed', [{ host: 'h', port: 1, nodeId: 'n1', source: 'cluster' }], current, () => null);
    expect(diff.refresh).toEqual([]);
  });
});

describe('retirement safety valve', () => {
  it.each([
    [1, 4, false],
    [2, 4, false],
    [3, 4, true],
    [1, 1, true],
    [0, 0, false],
  ])('%i of %i active auto children exceeds=%s', (retiring, active, expected) => {
    expect(exceedsRetirementThreshold(retiring, active)).toBe(expected);
  });

  it('keys retirement sets independent of order', () => {
    expect(retirementKey(['b', 'a'])).toBe(retirementKey(['a', 'b']));
  });
});
