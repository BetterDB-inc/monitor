import { collectionOf } from './node-collection';

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
