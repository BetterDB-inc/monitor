import type { ClusterNode } from '../common/types/metrics.types';
import { buildNodeDirectory, resolveNodeRef, toClusterNodeRef } from './node-ref';

function node(overrides: Partial<ClusterNode> & Pick<ClusterNode, 'id' | 'address'>): ClusterNode {
  return {
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [],
    ...overrides,
  };
}

const PRIMARY = node({
  id: 'primary-1',
  address: '10.0.0.1:6379@16379',
  flags: ['myself', 'master'],
  shardId: 'shard-1',
  availabilityZone: 'eu-west-1a',
});
const REPLICA = node({
  id: 'replica-1',
  address: '10.0.0.2:6379@16379',
  flags: ['slave'],
  master: 'primary-1',
  hostname: 'Replica-1.Example.com',
  shardId: 'shard-1',
});
const HANDSHAKING = node({ id: 'new-1', address: '10.0.0.3:6379@16379', flags: ['handshake'] });

describe('toClusterNodeRef', () => {
  it('describes a primary with its shard and zone', () => {
    expect(toClusterNodeRef(PRIMARY)).toEqual({
      nodeId: 'primary-1',
      address: '10.0.0.1:6379',
      role: 'primary',
      shardId: 'shard-1',
      availabilityZone: 'eu-west-1a',
    });
  });

  it('describes a replica and leaves out a zone it does not have', () => {
    expect(toClusterNodeRef(REPLICA)).toEqual({
      nodeId: 'replica-1',
      address: '10.0.0.2:6379',
      role: 'replica',
      shardId: 'shard-1',
    });
  });

  it('reports the role as unknown for a node with neither role flag', () => {
    expect(toClusterNodeRef(HANDSHAKING)).toEqual({ nodeId: 'new-1', address: '10.0.0.3:6379', role: 'unknown' });
  });
});

describe('resolveNodeRef', () => {
  const directory = buildNodeDirectory([PRIMARY, REPLICA, HANDSHAKING]);

  it('finds a node by its id', () => {
    expect(resolveNodeRef(directory, { nodeId: 'replica-1' })?.address).toBe('10.0.0.2:6379');
  });

  it('finds a node by its address, with or without the bus port', () => {
    expect(resolveNodeRef(directory, { address: '10.0.0.2:6379' })?.nodeId).toBe('replica-1');
    expect(resolveNodeRef(directory, { address: '10.0.0.2:6379@16379' })?.nodeId).toBe('replica-1');
  });

  it('finds a node by its announced hostname in any letter case', () => {
    expect(resolveNodeRef(directory, { address: 'replica-1.example.com:6379' })?.nodeId).toBe('replica-1');
  });

  it('answers nothing for a node the view does not hold', () => {
    expect(resolveNodeRef(directory, { nodeId: 'gone' })).toBeUndefined();
    expect(resolveNodeRef(directory, { address: '10.9.9.9:6379' })).toBeUndefined();
    expect(resolveNodeRef(directory, { address: 'not an address' })).toBeUndefined();
  });

  it('answers nothing without a subject', () => {
    expect(resolveNodeRef(directory, undefined)).toBeUndefined();
  });

  it('remembers which node answered the read', () => {
    expect(directory.selfId).toBe('primary-1');
  });

  it('has no own node when the view marks none', () => {
    expect(buildNodeDirectory([REPLICA]).selfId).toBeUndefined();
  });

  it('answers nothing from a missing directory', () => {
    expect(resolveNodeRef(undefined, { nodeId: 'primary-1' })).toBeUndefined();
  });
});

describe('buildNodeDirectory with two ids at one address', () => {
  const live = node({ id: 'live-1', address: '10.0.0.9:6379@16379', flags: ['slave'], master: 'primary-1' });
  const atAddress = (nodes: ClusterNode[]) =>
    resolveNodeRef(buildNodeDirectory(nodes), { address: '10.0.0.9:6379' })?.nodeId;

  it.each([['fail'], ['noaddr'], ['handshake']])('prefers the live node over one flagged %s', (flag) => {
    const stale = node({ id: 'stale-1', address: '10.0.0.9:6379@16379', flags: ['master', flag] });

    expect(atAddress([live, stale])).toBe('live-1');
    expect(atAddress([stale, live])).toBe('live-1');
  });

  it('prefers the live node over one the peers only suspect', () => {
    const suspect = node({ id: 'suspect-1', address: '10.0.0.9:6379@16379', flags: ['master', 'fail?'] });

    expect(atAddress([live, suspect])).toBe('live-1');
    expect(atAddress([suspect, live])).toBe('live-1');
  });

  it.each([['fail'], ['noaddr'], ['handshake']])('prefers a suspected node over one flagged %s', (flag) => {
    const suspect = node({ id: 'suspect-1', address: '10.0.0.9:6379@16379', flags: ['master', 'fail?'] });
    const stale = node({ id: 'stale-1', address: '10.0.0.9:6379@16379', flags: ['master', flag] });

    expect(atAddress([suspect, stale])).toBe('suspect-1');
    expect(atAddress([stale, suspect])).toBe('suspect-1');
  });

  it('still finds a suspected node that is alone at its address', () => {
    const suspect = node({ id: 'suspect-1', address: '10.0.0.9:6379@16379', flags: ['master', 'fail?'] });

    expect(atAddress([suspect])).toBe('suspect-1');
  });

  it('prefers the node that answered the read among live nodes', () => {
    const own = node({ id: 'own-1', address: '10.0.0.9:6379@16379', flags: ['myself', 'master'] });

    expect(atAddress([own, live])).toBe('own-1');
    expect(atAddress([live, own])).toBe('own-1');
  });

  it('keeps the first of two nodes that are equally live', () => {
    const twin = node({ id: 'twin-1', address: '10.0.0.9:6379@16379' });

    expect(atAddress([live, twin])).toBe('live-1');
  });

  it('gives a stale hostname to the live node that announces it now', () => {
    const gone = node({ id: 'gone-1', address: '10.0.0.8:6379@16379', flags: ['master', 'fail'], hostname: 'node-9' });
    const named = { ...live, hostname: 'node-9' };

    const directory = buildNodeDirectory([named, gone]);

    expect(resolveNodeRef(directory, { address: 'node-9:6379' })?.nodeId).toBe('live-1');
    expect(resolveNodeRef(directory, { address: '10.0.0.8:6379' })?.nodeId).toBe('gone-1');
  });

  it('still finds each of the two by its id', () => {
    const stale = node({ id: 'stale-1', address: '10.0.0.9:6379@16379', flags: ['master', 'fail'] });
    const directory = buildNodeDirectory([live, stale]);

    expect(resolveNodeRef(directory, { nodeId: 'stale-1' })?.nodeId).toBe('stale-1');
    expect(resolveNodeRef(directory, { nodeId: 'live-1' })?.nodeId).toBe('live-1');
  });
});
