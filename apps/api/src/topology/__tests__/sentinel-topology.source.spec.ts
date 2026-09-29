import { SentinelTopologySource } from '../sentinel-topology.source';

const flat = (fields: Record<string, string>) => Object.entries(fields).flat();
const seed = { id: 'seed', name: 'sentinels', host: 's1', port: 26379, isDefault: true, createdAt: 1 };

function build(replies: Record<string, unknown[] | Error>) {
  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    on: jest.fn(),
    call: jest.fn((_cmd: string, sub: string, name?: string) => {
      const reply = replies[name ? `${sub} ${name}` : sub];
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply ?? []);
    }),
  };
  const registry = { get: () => ({ getClient: () => ({ options: { host: 's1', port: 26379, username: 'u', password: 'p', tls: undefined } }) }) };
  const factory = jest.fn(() => client);
  return { source: new SentinelTopologySource(registry as never, factory as never), client, factory };
}

describe('SentinelTopologySource', () => {
  it('handles sentinel seeds only', () => {
    const { source } = build({});
    expect(source.handles({ isSentinel: true } as never)).toBe(true);
    expect(source.handles({ clusterEnabled: true } as never)).toBe(false);
  });

  it('emits a primary and its replicas per group', async () => {
    const { source } = build({
      MASTERS: [flat({ name: 'mymaster', ip: '10.0.0.1', port: '6379', runid: 'p1', flags: 'master' })],
      'REPLICAS mymaster': [flat({ name: '10.0.0.2:6379', ip: '10.0.0.2', port: '6379', runid: 'r1', flags: 'slave' })],
    });
    await expect(source.discover(seed as never, 10_000)).resolves.toEqual({
      nodes: [
        { host: '10.0.0.1', port: 6379, nodeId: 'p1', source: 'sentinel', group: 'mymaster', role: 'primary' },
        { host: '10.0.0.2', port: 6379, nodeId: 'r1', source: 'sentinel', group: 'mymaster', role: 'replica' },
      ],
      unknownGroups: [],
    });
  });

  it('falls back to group/host:port when runid is empty', async () => {
    const { source } = build({
      MASTERS: [flat({ name: 'g', ip: 'h', port: '1', runid: '', flags: 'master' })],
    });
    const { nodes } = (await source.discover(seed as never, 10_000))!;
    expect(nodes[0].nodeId).toBe('g/h:1');
  });

  it('keeps nodes that sentinel reports as down', async () => {
    const { source } = build({
      MASTERS: [flat({ name: 'g', ip: 'h', port: '1', runid: 'p', flags: 'master' })],
      'REPLICAS g': [flat({ name: 'r:2', ip: 'r', port: '2', runid: 'x', flags: 'slave,s_down,disconnected' })],
    });
    const { nodes } = (await source.discover(seed as never, 10_000))!;
    expect(nodes.map((n) => n.host)).toEqual(['h', 'r']);
  });

  it('marks a group unknown when its replicas cannot be read', async () => {
    const { source } = build({
      MASTERS: [flat({ name: 'a', ip: 'h1', port: '1', runid: 'p', flags: 'master' }), flat({ name: 'b', ip: 'h2', port: '2', runid: 'q', flags: 'master' })],
      'REPLICAS a': new Error('NOPERM'),
      'REPLICAS b': [],
    });
    const result = (await source.discover(seed as never, 10_000))!;
    expect(result.unknownGroups).toEqual(['a']);
    expect(result.nodes.map((n) => n.group)).toEqual(['a', 'b']);
  });

  it('rejects when SENTINEL MASTERS fails and always disconnects', async () => {
    const { source, client } = build({ MASTERS: new Error('boom') });
    await expect(source.discover(seed as never, 10_000)).rejects.toThrow('boom');
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('treats a Sentinel that monitors no groups as an empty topology', async () => {
    const { source } = build({ MASTERS: [] });
    await expect(source.discover(seed as never, 500)).resolves.toEqual({ nodes: [], unknownGroups: [] });
  });

  it('reports no discovery when the SENTINEL MASTERS reply is malformed', async () => {
    const { source } = build({ MASTERS: ['garbage'] });
    await expect(source.discover(seed as never, 500)).resolves.toBeNull();
  });

  it('opens a dedicated time-limited client with the seed credentials', async () => {
    const { source, factory } = build({ MASTERS: [] });
    await source.discover(seed as never, 500);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      host: 's1', port: 26379, username: 'u', password: 'p', lazyConnect: true, enableOfflineQueue: false,
      maxRetriesPerRequest: 0, enableReadyCheck: false, connectTimeout: 500, commandTimeout: 500,
      connectionName: 'BetterDB-Monitor-Sentinel-Discovery',
    }));
  });
});
