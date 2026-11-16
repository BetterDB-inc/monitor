import { collectionOf, withinCluster } from './node-collection';

describe('collectionOf', () => {
  const registered = (known: Record<string, string>) => (host: string, port: number) =>
    known[`${host}:${port}`] ?? null;
  const node = { address: '10.0.0.2:6379', flags: ['master'] };

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
    expect(collectionOf({ address: ':0', flags: ['master', 'noaddr'] }, 'seed', registered({}))).toEqual({
      collected: false,
    });
  });
});

describe('withinCluster', () => {
  const registered = (known: Record<string, string>) => (host: string, port: number) =>
    known[`${host}:${port}`] ?? null;
  const ownNodeIds = (known: Record<string, string>) => (connectionId: string) => known[connectionId];
  const clusterNodeIds = new Set(['node-1', 'node-2']);
  const at = { '10.0.0.2:6379': 'conn-2' };

  it('keeps a connection whose own node is in the cluster', () => {
    const find = withinCluster(clusterNodeIds, registered(at), ownNodeIds({ 'conn-2': 'node-2' }));

    expect(find('10.0.0.2', 6379)).toBe('conn-2');
  });

  it('drops a connection at the address whose own node belongs to another cluster', () => {
    const find = withinCluster(clusterNodeIds, registered(at), ownNodeIds({ 'conn-2': 'other-9' }));

    expect(find('10.0.0.2', 6379)).toBeNull();
  });

  it('keeps a connection whose own node is not known', () => {
    const find = withinCluster(clusterNodeIds, registered(at), ownNodeIds({}));

    expect(find('10.0.0.2', 6379)).toBe('conn-2');
  });

  it('finds no connection where none is registered', () => {
    const find = withinCluster(clusterNodeIds, registered({}), ownNodeIds({}));

    expect(find('10.0.0.2', 6379)).toBeNull();
  });

  it('leaves a node of another cluster at the same address not collected', () => {
    const find = withinCluster(clusterNodeIds, registered(at), ownNodeIds({ 'conn-2': 'other-9' }));

    expect(collectionOf({ address: '10.0.0.2:6379', flags: ['master'] }, 'seed', find)).toEqual({ collected: false });
  });
});
