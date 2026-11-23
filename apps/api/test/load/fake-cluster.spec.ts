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

  it('counts the connections of each node on its own', async () => {
    await clientFor(0).ping();
    await clientFor(0).ping();
    await clientFor(1).ping();

    const clients = InfoParser.parse(await clientFor(2).info('clients')).clients as Record<string, string>;

    expect(cluster.stats().connectionsByNode.slice(0, 3)).toEqual([2, 1, 1]);
    expect(clients.connected_clients).toBe('21');
  });

  it('keeps the logs, the keyspace scan and the client list small in the empty profile', async () => {
    const client = clientFor(0);

    expect(await client.call('SLOWLOG', 'GET', '128')).toEqual([]);
    expect(await client.call('COMMANDLOG', 'GET', '128', 'slow')).toEqual([]);
    expect(await client.call('LATENCY', 'LATEST')).toEqual([]);
    expect(await client.scan('0', 'COUNT', 1000)).toEqual(['0', []]);
    expect(((await client.call('CLIENT', 'LIST')) as string).trim().split('\n')).toHaveLength(21);
  });

  describe('with the realistic profile', () => {
    beforeEach(async () => {
      await cluster.stop();
      cluster = await FakeCluster.start({ shards: 3, replicasPerShard: 1, profile: 'realistic' });
    });

    it('returns slow log entries the API can parse, no more than asked for', async () => {
      const client = clientFor(0);

      const all = MetricsParser.parseSlowLog((await client.call('SLOWLOG', 'GET', '128')) as unknown[]);
      const few = (await client.call('SLOWLOG', 'GET', '10')) as unknown[];

      expect(all).toHaveLength(128);
      expect(few).toHaveLength(10);
      expect(all[0].id).toBeGreaterThan(all[1].id);
      expect(all[0].duration).toBeGreaterThan(0);
      expect(all[0].command.length).toBeGreaterThan(0);
      expect(all[0].clientAddress).toMatch(/^\d+\.\d+\.\d+\.\d+:\d+$/);
      expect(await client.call('SLOWLOG', 'LEN')).toBe(128);
    });

    it('returns command log entries of the type asked for', async () => {
      const entries = MetricsParser.parseCommandLog(
        (await clientFor(0).call('COMMANDLOG', 'GET', '50', 'large-reply')) as unknown[],
      );

      expect(entries).toHaveLength(50);
      expect(new Set(entries.map((entry) => entry.type))).toEqual(new Set(['large-reply']));
    });

    it('returns latency events and their history', async () => {
      const client = clientFor(0);

      const latest = (await client.call('LATENCY', 'LATEST')) as unknown[][];
      const history = (await client.call('LATENCY', 'HISTORY', String(latest[0][0]))) as unknown[][];

      expect(latest).toHaveLength(4);
      expect(latest[0]).toHaveLength(4);
      expect(history.length).toBeGreaterThan(10);
      expect(history[0]).toHaveLength(2);
    });

    it('reports the same latency spikes on every read, with no new ones', async () => {
      const client = clientFor(0);
      const event = 'command';

      const latest = await client.call('LATENCY', 'LATEST');
      const history = await client.call('LATENCY', 'HISTORY', event);
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(await client.call('LATENCY', 'LATEST')).toEqual(latest);
      expect(await client.call('LATENCY', 'HISTORY', event)).toEqual(history);
    });

    it('agrees with itself about the keys of a slot and the keys that expire', async () => {
      const client = clientFor(0);
      const slotStats = (await client.call('CLUSTER', 'SLOT-STATS', 'SLOTSRANGE', '0', '0')) as Array<[number, unknown[]]>;
      const keysInSlot = Number(slotStats[0][1][slotStats[0][1].indexOf('key-count') + 1]);
      const keyspace = (await client.info('keyspace')).split('\r\n').find((line) => line.startsWith('db0:')) ?? '';
      const [, keys, expires] = /keys=(\d+),expires=(\d+)/.exec(keyspace) ?? [];

      const listed = (await client.call('CLUSTER', 'GETKEYSINSLOT', '0', '1000')) as string[];

      expect(await client.call('CLUSTER', 'COUNTKEYSINSLOT', '0')).toBe(keysInSlot);
      expect(await client.call('CLUSTER', 'COUNTKEYSINSLOT', '16383')).toBe(0);
      expect(listed).toHaveLength(keysInSlot);
      expect(new Set(listed).size).toBe(keysInSlot);
      expect(await client.call('CLUSTER', 'GETKEYSINSLOT', '0', '2')).toEqual(listed.slice(0, 2));
      expect(await client.call('CLUSTER', 'GETKEYSINSLOT', '16383', '10')).toEqual([]);
      expect(expires).toBe(keys);
    });

    it('lists 200 application clients and 60 commands in the command stats', async () => {
      const client = clientFor(0);

      const clients = MetricsParser.parseClientList((await client.call('CLIENT', 'LIST')) as string);
      const stats = await client.info('commandstats');

      expect(clients).toHaveLength(201);
      expect(stats.split('\r\n').filter((line) => line.startsWith('cmdstat_'))).toHaveLength(60);
    });

    it('pages through the keys of the node with SCAN and answers the per-key probes', async () => {
      const client = clientFor(0);
      const total = await client.dbsize();
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, page] = await client.scan(cursor, 'COUNT', 1000);
        cursor = next;
        keys.push(...page);
      } while (cursor !== '0');

      expect(keys).toHaveLength(total);
      expect(new Set(keys).size).toBe(total);
      expect(await client.type(keys[0])).toBe('string');
      expect(await client.call('MEMORY', 'USAGE', keys[0])).toBeGreaterThan(0);
      expect(await client.call('OBJECT', 'IDLETIME', keys[0])).toBeGreaterThanOrEqual(0);
      await expect(client.call('OBJECT', 'FREQ', keys[0])).rejects.toThrow('LFU maxmemory policy');
      expect(await client.ttl(keys[0])).toBeGreaterThan(0);
      expect(await client.strlen(keys[0])).toBeGreaterThan(0);
    });
  });

  it('gives every node of a large realistic cluster more keys than one key sample reads', async () => {
    await cluster.stop();
    cluster = await FakeCluster.start({ shards: 40, replicasPerShard: 0, profile: 'realistic' });
    const client = clientFor(39);

    const total = await client.dbsize();
    const slotStats = (await client.call('CLUSTER', 'SLOT-STATS', 'SLOTSRANGE', '0', '16383')) as Array<[number, unknown[]]>;
    const keysInSlots = slotStats.reduce((sum, [, fields]) => sum + Number(fields[fields.indexOf('key-count') + 1]), 0);

    expect(total).toBeGreaterThanOrEqual(20_000);
    expect(keysInSlots).toBe(total);
  });

  it('holds every reply back by the reply delay', async () => {
    await cluster.stop();
    cluster = await FakeCluster.start({ shards: 1, replicasPerShard: 0, replyDelayMs: 40 });
    const client = clientFor(0);
    await client.ping();

    const started = performance.now();
    const replies = await Promise.all([client.ping(), client.echo('second')]);

    expect(replies).toEqual(['PONG', 'second']);
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
  });

  it('refuses connections after stop', async () => {
    const { host, port } = cluster.nodes[0];
    await cluster.stop();

    const client = new Valkey({ host, port, lazyConnect: true, retryStrategy: () => null });
    client.on('error', () => undefined);
    await expect(client.connect()).rejects.toThrow();
  });
});
