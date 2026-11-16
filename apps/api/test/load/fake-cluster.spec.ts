import { connect } from 'net';
import Valkey from 'iovalkey';
import { MetricsParser } from '../../src/database/parsers/metrics.parser';
import { InfoParser } from '../../src/database/parsers/info.parser';
import { FakeCluster } from './fake-cluster';

const TOTAL_SLOTS = 16384;

describe('FakeCluster', () => {
  let cluster: FakeCluster;
  const clients: Valkey[] = [];

  const clientFor = (index: number): Valkey => {
    const node = cluster.nodes[index];
    const client = new Valkey({ host: node.host, port: node.port, lazyConnect: true, maxRetriesPerRequest: 0 });
    client.on('error', () => undefined);
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    cluster = await FakeCluster.start({ shards: 3, replicasPerShard: 1, zones: ['a', 'b', 'c'] });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await cluster.stop();
  });

  it('listens on one port per node', () => {
    expect(cluster.nodes).toHaveLength(6);
    expect(new Set(cluster.nodes.map((node) => node.port)).size).toBe(6);
    expect(cluster.nodes.filter((node) => node.role === 'master')).toHaveLength(3);
  });

  it('answers PING and INFO with the identity of the node asked', async () => {
    const first = clientFor(0);
    const second = clientFor(1);

    expect(await first.ping()).toBe('PONG');
    const firstInfo = InfoParser.parse(await first.info('server'));
    const secondInfo = InfoParser.parse(await second.info('server'));

    expect(InfoParser.getVersion(firstInfo)).toBeTruthy();
    expect(InfoParser.isValkey(firstInfo)).toBe(true);
    expect((firstInfo.server as Record<string, string>).run_id).toBe(cluster.nodes[0].runId);
    expect((secondInfo.server as Record<string, string>).run_id).toBe(cluster.nodes[1].runId);
    expect((firstInfo.server as Record<string, string>).tcp_port).toBe(String(cluster.nodes[0].port));
  });

  it('reports the role of the node in INFO replication', async () => {
    const primaryIndex = cluster.nodes.findIndex((node) => node.role === 'master');
    const replicaIndex = cluster.nodes.findIndex((node) => node.role === 'slave');

    const primary = InfoParser.parse(await clientFor(primaryIndex).info('replication'));
    const replica = InfoParser.parse(await clientFor(replicaIndex).info('replication'));

    expect((primary.replication as Record<string, string>).role).toBe('master');
    expect((primary.replication as Record<string, string>).connected_slaves).toBe('1');
    expect((replica.replication as Record<string, string>).role).toBe('slave');
    expect((replica.replication as Record<string, string>).master_link_status).toBe('up');
  });

  it('returns the whole topology from CLUSTER NODES with myself on the node asked', async () => {
    const raw = (await clientFor(2).call('CLUSTER', 'NODES')) as string;
    const nodes = MetricsParser.parseClusterNodes(raw);

    expect(nodes).toHaveLength(6);
    const myself = nodes.filter((node) => node.flags.includes('myself'));
    expect(myself).toHaveLength(1);
    expect(myself[0].id).toBe(cluster.nodes[2].id);

    const covered = nodes
      .flatMap((node) => node.slots)
      .reduce((sum, [start, end]) => sum + end - start + 1, 0);
    expect(covered).toBe(TOTAL_SLOTS);

    for (const replica of nodes.filter((node) => node.flags.includes('slave'))) {
      expect(nodes.some((node) => node.id === replica.master && node.flags.includes('master'))).toBe(true);
    }
  });

  it('returns shards with a primary, replicas and zones from CLUSTER SHARDS', async () => {
    const shards = MetricsParser.parseClusterShards((await clientFor(0).call('CLUSTER', 'SHARDS')) as unknown[]);

    expect(shards).toHaveLength(3);
    for (const shard of shards) {
      expect(shard.nodes.filter((node) => node.role === 'master')).toHaveLength(1);
      expect(shard.nodes.filter((node) => node.role === 'replica')).toHaveLength(1);
      expect(shard.nodes.every((node) => node.health === 'online')).toBe(true);
      expect(shard.nodes.every((node) => ['a', 'b', 'c'].includes(node.availabilityZone ?? ''))).toBe(true);
    }
  });

  it('reports an ok cluster in CLUSTER INFO', async () => {
    const info = (await clientFor(0).call('CLUSTER', 'INFO')) as string;

    expect(info).toContain('cluster_state:ok');
    expect(info).toContain('cluster_known_nodes:6');
    expect(info).toContain('cluster_size:3');
  });

  it('counts commands and bytes by command name', async () => {
    const client = clientFor(0);
    await client.ping();
    cluster.resetStats();

    await client.ping();
    await client.call('CLUSTER', 'NODES');
    await client.call('CLUSTER', 'NODES');
    await client.info('server');

    const stats = cluster.stats();
    expect(stats.commands['PING'].count).toBe(1);
    expect(stats.commands['CLUSTER NODES'].count).toBe(2);
    expect(stats.commands['INFO server'].count).toBe(1);
    expect(stats.commands['CLUSTER NODES'].bytesOut).toBeGreaterThan(2 * 6 * 100);
    expect(stats.totalCommands).toBe(4);
    expect(stats.bytesOut).toBeGreaterThan(stats.commands['CLUSTER NODES'].bytesOut);
    expect(stats.bytesIn).toBeGreaterThan(0);
    expect(stats.commandsByNode[0]).toBe(4);
    expect(stats.commandsByNode[1]).toBe(0);
  });

  it('answers unknown commands with an error and counts them', async () => {
    const client = clientFor(0);

    await expect(client.call('NOSUCHCOMMAND', 'x')).rejects.toThrow(/unknown command/);

    expect(cluster.stats().unknownCommands).toEqual({ NOSUCHCOMMAND: 1 });
  });

  it('keeps a hung node silent while the others answer, and replies after resume', async () => {
    const hung = clientFor(1);
    const healthy = clientFor(0);
    await hung.ping();

    cluster.hang(1);
    let settled = false;
    const pending = hung.ping().then((reply) => {
      settled = true;
      return reply;
    });

    expect(await healthy.ping()).toBe('PONG');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);

    const accepted = await new Promise<boolean>((resolve) => {
      const socket = connect(cluster.nodes[1].port, cluster.nodes[1].host, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    expect(accepted).toBe(true);

    cluster.resume(1);
    expect(await pending).toBe('PONG');
  });

  it('promotes a replica on failover and shows it from every node', async () => {
    const before = MetricsParser.parseClusterNodes((await clientFor(0).call('CLUSTER', 'NODES')) as string);
    const oldPrimary = cluster.nodes.find((node) => node.shard === 1 && node.role === 'master')!;
    const epochBefore = Math.max(...before.map((node) => node.configEpoch));

    const promoted = cluster.failover(1);

    expect(promoted.shard).toBe(1);
    expect(promoted.id).not.toBe(oldPrimary.id);
    for (const index of [0, 3, 5]) {
      const view = MetricsParser.parseClusterNodes((await clientFor(index).call('CLUSTER', 'NODES')) as string);
      const newPrimary = view.find((node) => node.id === promoted.id)!;
      const demoted = view.find((node) => node.id === oldPrimary.id)!;
      expect(newPrimary.flags).toContain('master');
      expect(newPrimary.slots.length).toBeGreaterThan(0);
      expect(newPrimary.configEpoch).toBe(epochBefore + 1);
      expect(demoted.flags).toContain('slave');
      expect(demoted.master).toBe(promoted.id);
      expect(demoted.slots).toHaveLength(0);
    }

    const promotedIndex = cluster.nodes.findIndex((node) => node.id === promoted.id);
    const replication = InfoParser.parse(await clientFor(promotedIndex).info('replication'));
    expect((replication.replication as Record<string, string>).role).toBe('master');
    const clusterInfo = (await clientFor(0).call('CLUSTER', 'INFO')) as string;
    expect(clusterInfo).toContain(`cluster_current_epoch:${epochBefore + 1}`);
  });

  it('refuses connections after stop', async () => {
    const { host, port } = cluster.nodes[0];
    await cluster.stop();

    const client = new Valkey({ host, port, lazyConnect: true, retryStrategy: () => null });
    client.on('error', () => undefined);
    await expect(client.connect()).rejects.toThrow();
  });
});
