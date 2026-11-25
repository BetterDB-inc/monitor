import { discoverNodes, parseClusterNodes, parseClusterShards } from '../cluster-discovery';

const SHARDS = [
  [
    'slots', [0, 5460],
    'nodes', [
      ['id', 'aaa', 'port', 0, 'tls-port', 6379, 'ip', '10.0.0.11', 'endpoint', '10.0.0.11', 'role', 'master', 'replication-offset', 100, 'health', 'online'],
      ['id', 'bbb', 'port', 0, 'tls-port', 6379, 'ip', '10.0.0.12', 'endpoint', '10.0.0.12', 'role', 'replica', 'replication-offset', 100, 'health', 'online'],
    ],
  ],
  [
    'slots', [5461, 16383],
    'nodes', [
      ['id', 'ccc', 'port', 6379, 'ip', '10.0.0.13', 'endpoint', 'valkey-x-2.valkey-x.db.svc', 'hostname', 'valkey-x-2.valkey-x.db.svc', 'role', 'master', 'health', 'online'],
      ['id', 'ddd', 'port', 6379, 'ip', '10.0.0.14', 'endpoint', '?', 'role', 'replica', 'health', 'fail'],
    ],
  ],
];

function fakeClient(replies: Record<string, unknown | Error>) {
  const calls: string[] = [];
  return {
    calls,
    async call(command: string, ...args: string[]) {
      const key = [command, ...args].join(' ');
      calls.push(key);
      const reply = replies[key];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error(`ERR unknown command ${key}`);
      return reply;
    },
  };
}

describe('parseClusterShards', () => {
  it('lists one entry per online node with its stable id, address and role', () => {
    const nodes = parseClusterShards(SHARDS);
    expect(nodes).toEqual([
      { id: 'aaa', host: '10.0.0.11', port: 6379, role: 'primary', hostname: undefined },
      { id: 'bbb', host: '10.0.0.12', port: 6379, role: 'replica', hostname: undefined },
      { id: 'ccc', host: 'valkey-x-2.valkey-x.db.svc', port: 6379, role: 'primary', hostname: 'valkey-x-2.valkey-x.db.svc' },
    ]);
  });

  it('falls back to the other port when the preferred one is 0, as a TLS-only cluster reports', () => {
    expect(parseClusterShards(SHARDS, { tls: false })[0].port).toBe(6379);
    expect(parseClusterShards(SHARDS, { tls: true })[0].port).toBe(6379);
  });

  it('picks tls-port or port by the connection TLS setting when a node serves both', () => {
    const both = [['slots', [0, 16383], 'nodes', [
      ['id', 'aaa', 'port', 6379, 'tls-port', 6380, 'ip', '10.0.0.11', 'endpoint', '10.0.0.11', 'role', 'master', 'health', 'online'],
    ]]];
    expect(parseClusterShards(both, { tls: false })[0].port).toBe(6379);
    expect(parseClusterShards(both, { tls: true })[0].port).toBe(6380);
  });
});

describe('parseClusterNodes', () => {
  const RAW = [
    'aaa 10.0.0.11:6379@16379 myself,master - 0 0 1 connected 0-5460',
    'bbb 10.0.0.12:6379@16379,valkey-x-1.valkey-x.db.svc slave aaa 0 1 1 connected',
    'eee :0@0 master,fail,noaddr - 0 0 0 disconnected',
    'fff 10.0.0.15:6379@16379 handshake - 0 0 0 connected',
    '',
  ].join('\n');

  it('parses addresses, hostnames and roles, skipping failed or unaddressed nodes', () => {
    expect(parseClusterNodes(RAW)).toEqual([
      { id: 'aaa', host: '10.0.0.11', port: 6379, role: 'primary', hostname: undefined },
      { id: 'bbb', host: '10.0.0.12', port: 6379, role: 'replica', hostname: 'valkey-x-1.valkey-x.db.svc' },
    ]);
  });
});

describe('discoverNodes', () => {
  const seed = { host: 'valkey-x.db.svc.cluster.local', port: 6379 };

  it('returns the per-node target set from CLUSTER SHARDS, sorted and deduplicated', async () => {
    const client = fakeClient({
      'INFO cluster': '# Cluster\r\ncluster_enabled:1\r\n',
      'CLUSTER SHARDS': [...SHARDS, SHARDS[0]],
    });

    const nodes = await discoverNodes(client, seed);

    expect(nodes.map((n) => n.id)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(nodes.every((n) => n.host !== seed.host)).toBe(true);
    expect(client.calls).toEqual(['INFO cluster', 'CLUSTER SHARDS']);
  });

  it('falls back to CLUSTER NODES on servers without CLUSTER SHARDS', async () => {
    const client = fakeClient({
      'INFO cluster': 'cluster_enabled:1',
      'CLUSTER SHARDS': new Error("ERR unknown subcommand 'SHARDS'"),
      'CLUSTER NODES': 'aaa 10.0.0.11:6379@16379 master - 0 0 1 connected 0-16383\n',
    });

    expect(await discoverNodes(client, seed)).toEqual([
      { id: 'aaa', host: '10.0.0.11', port: 6379, role: 'primary', hostname: undefined },
    ]);
  });

  it('monitors a standalone server as a single node keyed by its address', async () => {
    const client = fakeClient({ 'INFO cluster': '# Cluster\r\ncluster_enabled:0\r\n' });

    expect(await discoverNodes(client, seed)).toEqual([
      { id: 'valkey-x.db.svc.cluster.local:6379', host: seed.host, port: 6379, role: 'primary' },
    ]);
  });

  it('falls back to CLUSTER INFO answering when INFO cluster is unavailable', async () => {
    const client = fakeClient({
      'INFO cluster': new Error('NOPERM'),
      'CLUSTER INFO': 'cluster_state:ok',
      'CLUSTER SHARDS': SHARDS,
    });

    expect((await discoverNodes(client, seed)).map((n) => n.id)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('treats a server that says cluster support is disabled as standalone', async () => {
    const client = fakeClient({
      'INFO cluster': new Error('NOPERM'),
      'CLUSTER INFO': new Error('ERR This instance has cluster support disabled'),
    });

    expect((await discoverNodes(client, seed)).map((n) => n.id)).toEqual(['valkey-x.db.svc.cluster.local:6379']);
  });

  it('fails instead of concluding standalone when both cluster probes fail for another reason', async () => {
    const client = fakeClient({
      'INFO cluster': new Error('LOADING server is loading'),
      'CLUSTER INFO': new Error('LOADING server is loading'),
    });

    await expect(discoverNodes(client, seed)).rejects.toThrow(/cluster probe failed/);
  });

  it('fails loudly when the cluster reports no reachable node', async () => {
    const client = fakeClient({ 'INFO cluster': 'cluster_enabled:1', 'CLUSTER SHARDS': [] });

    await expect(discoverNodes(client, seed)).rejects.toThrow(/no reachable nodes/);
  });
});
