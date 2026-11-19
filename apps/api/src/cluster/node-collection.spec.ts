import { collectionAmong, collectionOf } from './node-collection';

describe('collectionOf', () => {
  const registered = (known: Record<string, string>) => (host: string, port: number) =>
    known[`${host}:${port}`] ?? null;
  const node = { id: 'node-2', address: '10.0.0.2:6379', flags: ['master'] };

  it('says a node with a connection at its address is collected by that connection', () => {
    expect(collectionOf(node, 'seed', registered({ '10.0.0.2:6379': 'conn-2' }))).toEqual({
      collected: true,
      connectionId: 'conn-2',
    });
  });

  it('says a node with a connection at its announced hostname is collected', () => {
    const named = { ...node, hostname: 'node-2.internal' };

    expect(collectionOf(named, 'seed', registered({ 'node-2.internal:6379': 'conn-2' }))).toEqual({
      collected: true,
      connectionId: 'conn-2',
    });
  });

  it('says the node the viewing connection reads is collected by it', () => {
    const own = { ...node, flags: ['myself', 'master'] };

    expect(collectionOf(own, 'seed', registered({}))).toEqual({ collected: true, connectionId: 'seed' });
  });

  it('prefers the connection at the address over the viewing connection', () => {
    const own = { ...node, flags: ['myself', 'master'] };

    expect(collectionOf(own, 'seed', registered({ '10.0.0.2:6379': 'conn-2' })).connectionId).toBe('conn-2');
  });

  it('says a node no connection points at is not collected', () => {
    expect(collectionOf(node, 'seed', registered({}))).toEqual({ collected: false });
  });

  it('reads an address that carries the cluster bus port', () => {
    const withBus = { ...node, address: '10.0.0.2:6379@16379' };

    expect(collectionOf(withBus, 'seed', registered({ '10.0.0.2:6379': 'conn-2' })).collected).toBe(true);
  });

  it('says a node without a usable address is not collected', () => {
    expect(collectionOf({ id: 'node-3', address: ':0', flags: ['master', 'noaddr'] }, 'seed', registered({}))).toEqual({
      collected: false,
    });
  });
});

describe('collectionOf with the node each connection reads', () => {
  const registered = (known: Record<string, string>) => (host: string, port: number) =>
    known[`${host}:${port}`] ?? null;
  const ownNodeIds = (known: Record<string, string>) => (connectionId: string) => known[connectionId];
  const node = { id: 'node-2', address: '10.0.0.2:6379', flags: ['master'] };
  const at = { '10.0.0.2:6379': 'conn-2' };

  it('counts a connection that reads this node', () => {
    expect(collectionOf(node, 'seed', registered(at), ownNodeIds({ 'conn-2': 'node-2' }))).toEqual({
      collected: true,
      connectionId: 'conn-2',
    });
  });

  it('does not count a connection at the address that reads a node of another cluster', () => {
    expect(collectionOf(node, 'seed', registered(at), ownNodeIds({ 'conn-2': 'other-9' }))).toEqual({
      collected: false,
    });
  });

  it('does not count a connection at the address that reads another node of this cluster', () => {
    const replaced = { ...node, id: 'node-1', flags: ['master', 'fail'] };

    expect(collectionOf(replaced, 'seed', registered(at), ownNodeIds({ 'conn-2': 'node-2' }))).toEqual({
      collected: false,
    });
  });

  it('does not count a connection at the announced hostname that reads another node', () => {
    const named = { ...node, hostname: 'node-2.internal' };
    const byName = registered({ 'node-2.internal:6379': 'conn-2' });

    expect(collectionOf(named, 'seed', byName, ownNodeIds({ 'conn-2': 'node-1' }))).toEqual({ collected: false });
  });

  it('counts a connection whose own node is not known', () => {
    expect(collectionOf(node, 'seed', registered(at), ownNodeIds({}))).toEqual({
      collected: true,
      connectionId: 'conn-2',
    });
  });

  it('still counts the viewing connection for its own node when another node is read at the address', () => {
    const own = { ...node, flags: ['myself', 'master'] };

    expect(collectionOf(own, 'seed', registered(at), ownNodeIds({ 'conn-2': 'node-1' }))).toEqual({
      collected: true,
      connectionId: 'seed',
    });
  });

  it('does not count the viewing connection for a node marked as its own when it reads another node', () => {
    const own = { ...node, flags: ['myself', 'master'] };

    expect(collectionOf(own, 'seed', registered({}), ownNodeIds({ seed: 'node-9' }))).toEqual({ collected: false });
  });

  it('counts the viewing connection for the node marked as its own when it reads that node', () => {
    const own = { ...node, flags: ['myself', 'master'] };

    expect(collectionOf(own, 'seed', registered({}), ownNodeIds({ seed: 'node-2' }))).toEqual({
      collected: true,
      connectionId: 'seed',
    });
  });
});

describe('collectionOf with the node each connection was seen reading', () => {
  const registered = (known: Record<string, string>) => (host: string, port: number) =>
    known[`${host}:${port}`] ?? null;
  const ownNodeIds = (known: Record<string, string>) => (connectionId: string) => known[connectionId];
  const readers = (known: Record<string, string>) => (nodeId: string) => known[nodeId] ?? null;
  const node = { id: 'node-2', address: '10.0.0.2:6379', flags: ['master'] };

  it('counts a connection that reads the node through another address', () => {
    expect(collectionOf(node, 'seed', registered({}), ownNodeIds({}), readers({ 'node-2': 'conn-nat' }))).toEqual({
      collected: true,
      connectionId: 'conn-nat',
    });
  });

  it('prefers the connection that reads the node over one that only shares its address', () => {
    const collection = collectionOf(
      node,
      'seed',
      registered({ '10.0.0.2:6379': 'conn-at-address' }),
      ownNodeIds({}),
      readers({ 'node-2': 'conn-reader' }),
    );

    expect(collection.connectionId).toBe('conn-reader');
  });

  it('does not count a dead node that shares the address of the node a connection reads', () => {
    const dead = { id: 'node-dead', address: '10.0.0.2:6379', flags: ['master', 'fail'] };
    const at = registered({ '10.0.0.2:6379': 'conn-2' });
    const reads = { 'conn-2': 'node-2' };

    expect(collectionOf(dead, 'seed', at, ownNodeIds(reads), readers({ 'node-2': 'conn-2' }))).toEqual({
      collected: false,
    });
    expect(collectionOf(node, 'seed', at, ownNodeIds(reads), readers({ 'node-2': 'conn-2' }))).toEqual({
      collected: true,
      connectionId: 'conn-2',
    });
  });
});

describe('collectionAmong', () => {
  const node = { id: 'node-2', address: '10.0.0.2:6379', flags: ['master'] };
  const connections = (
    seenReading: Record<string, string>,
    saved: Record<string, string>,
    outside: string[] = [],
  ) => ({
    isOutsideCluster: (id: string) => outside.includes(id),
    findIdByHostPort: (host: string, port: number) => (`${host}:${port}` === '10.0.0.2:6379' ? 'conn-2' : null),
    findIdObservingNode: (nodeId: string) =>
      Object.keys(seenReading).find((id) => seenReading[id] === nodeId) ?? null,
    getObservedNodeId: (id: string) => seenReading[id],
    getConfig: (id: string) => (saved[id] ? { membership: { nodeId: saved[id] } } : null),
  });

  it('trusts the node a connection was seen reading over the one saved for it', () => {
    expect(collectionAmong(node, 'seed', connections({ 'conn-2': 'node-2' }, { 'conn-2': 'node-old' }))).toEqual({
      collected: true,
      connectionId: 'conn-2',
    });
    expect(collectionAmong(node, 'seed', connections({ 'conn-2': 'node-new' }, { 'conn-2': 'node-2' }))).toEqual({
      collected: false,
    });
  });

  it('falls back to the saved node of a connection that was not seen reading yet', () => {
    expect(collectionAmong(node, 'seed', connections({}, { 'conn-2': 'node-2' })).collected).toBe(true);
    expect(collectionAmong(node, 'seed', connections({}, { 'conn-2': 'node-9' })).collected).toBe(false);
    expect(collectionAmong(node, 'seed', connections({}, {})).collected).toBe(true);
  });

  it('does not count a connection at the address that answers outside the cluster', () => {
    expect(collectionAmong(node, 'seed', connections({}, { 'conn-2': 'node-2' }, ['conn-2']))).toEqual({
      collected: false,
    });
    expect(collectionAmong(node, 'seed', connections({}, {}, ['conn-2']))).toEqual({ collected: false });
  });

  it('counts the viewing connection for its own node whatever is registered at the address', () => {
    const own = { ...node, flags: ['myself', 'master'] };

    expect(collectionAmong(own, 'seed', connections({}, {}, ['conn-2']))).toEqual({
      collected: true,
      connectionId: 'seed',
    });
  });

  it('does not count the viewing connection for a node marked as its own once it was seen reading another', () => {
    const own = { ...node, flags: ['myself', 'master'] };

    expect(collectionAmong(own, 'seed', connections({ seed: 'node-new' }, {}, ['conn-2']))).toEqual({
      collected: false,
    });
    expect(collectionAmong(own, 'seed', connections({}, { seed: 'node-new' }, ['conn-2']))).toEqual({
      collected: false,
    });
  });
});
