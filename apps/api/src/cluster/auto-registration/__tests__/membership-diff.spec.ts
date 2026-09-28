import type { ClusterMembership } from '@betterdb/shared';
import type { DiscoveredNode } from '../../cluster-discovery.service';
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

function member(id: string, address: string, membership: Partial<ClusterMembership> = {}): MemberSnapshot {
  const [host, port] = address.split(':');
  return { id, host, port: Number(port), membership: { seedId: 'seed', nodeId: id, origin: 'auto', ...membership } };
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
    expect(desired).toEqual([{ host: '10.0.0.5', port: 7005, nodeId: 'e' }]);
  });
});

describe('diffMembership', () => {
  it('adds unknown addresses', () => {
    const diff = diffMembership('seed', [{ host: '10.0.0.2', port: 7002, nodeId: 'n2' }], [], none);
    expect(diff.add).toEqual([{ host: '10.0.0.2', port: 7002, nodeId: 'n2' }]);
  });

  it('refreshes the node id when a node is replaced at the same address', () => {
    const diff = diffMembership('seed', [{ host: '10.0.0.2', port: 7002, nodeId: 'new' }], [member('c2', '10.0.0.2:7002', { nodeId: 'old' })], none);
    expect(diff.refreshNodeId).toEqual([{ id: 'c2', nodeId: 'new' }]);
    expect(diff.add).toEqual([]);
  });

  it('matches addresses case-insensitively', () => {
    const diff = diffMembership('seed', [{ host: 'Node-2.local', port: 7002, nodeId: 'c2' }], [member('c2', 'node-2.local:7002')], none);
    expect(diff).toMatchObject({ add: [], retire: [], refreshNodeId: [] });
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
    const diff = diffMembership('seed', [{ host: '10.0.0.3', port: 7003, nodeId: 'n3' }], [member('c3', '10.0.0.3:7003', { retiredAt: 1 })], none);
    expect(diff.reactivate).toEqual([{ id: 'c3', nodeId: 'n3' }]);
  });

  it('skips reactivation when another connection took the address', () => {
    const owner: AddressOwner = { id: 'otlp', connectionType: 'external' };
    const diff = diffMembership('seed', [{ host: '10.0.0.3', port: 7003, nodeId: 'n3' }], [member('c3', '10.0.0.3:7003', { retiredAt: 1 })], () => owner);
    expect(diff.reactivate).toEqual([]);
    expect(diff.skipped).toEqual([{ host: '10.0.0.3', port: 7003, reason: 'occupied' }]);
  });

  it('adopts an unclaimed direct connection at a discovered address', () => {
    const owner: AddressOwner = { id: 'manual', connectionType: 'direct' };
    const diff = diffMembership('seed', [{ host: '10.0.0.3', port: 7003, nodeId: 'n3' }], [], () => owner);
    expect(diff.adopt).toEqual([{ id: 'manual', nodeId: 'n3' }]);
  });

  it('skips addresses claimed by another seed or pushed over OTLP', () => {
    const lookup = (host: string): AddressOwner =>
      host === '10.0.0.3'
        ? { id: 'x', connectionType: 'direct', membership: { seedId: 'other', nodeId: 'n3', origin: 'auto' } }
        : { id: 'y', connectionType: 'external' };
    const diff = diffMembership('seed', [
      { host: '10.0.0.3', port: 7003, nodeId: 'n3' },
      { host: '10.0.0.4', port: 7004, nodeId: 'n4' },
    ], [], lookup);
    expect(diff.skipped).toEqual([
      { host: '10.0.0.3', port: 7003, reason: 'claimed' },
      { host: '10.0.0.4', port: 7004, reason: 'external' },
    ]);
    expect(diff.add).toEqual([]);
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
