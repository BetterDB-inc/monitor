import type { ClusterShard } from '../common/types/metrics.types';
import { normalizeNodeAvailabilityZones } from '@betterdb/shared';
import { CLUSTER_SHARDS_TIMEOUT_MS, readClusterShards, withConfiguredZones, withShardMetadata } from './shard-metadata';

describe('withShardMetadata', () => {
  const shards: ClusterShard[] = [
    {
      shardId: 'shard-1',
      slots: [[0, 5460]],
      nodes: [
        { id: 'primary-1', role: 'master', availabilityZone: 'us-east-1a' },
        { id: 'replica-1', role: 'replica', availabilityZone: 'us-east-1b' },
      ],
    },
    {
      shardId: 'shard-2',
      slots: [[5461, 16383]],
      nodes: [{ id: 'primary-2', role: 'master' }],
    },
  ];

  it('attaches the zone and shard id to each node by node id', () => {
    const nodes = [
      { id: 'primary-1', address: '10.0.0.1:6379' },
      { id: 'replica-1', address: '10.0.0.2:6379' },
    ];

    expect(withShardMetadata(nodes, shards)).toEqual([
      { id: 'primary-1', address: '10.0.0.1:6379', availabilityZone: 'us-east-1a', shardId: 'shard-1' },
      { id: 'replica-1', address: '10.0.0.2:6379', availabilityZone: 'us-east-1b', shardId: 'shard-1' },
    ]);
  });

  it('sets only the shard id for a node that reports no zone', () => {
    const [node] = withShardMetadata([{ id: 'primary-2' }], shards);

    expect(node).toEqual({ id: 'primary-2', shardId: 'shard-2' });
    expect(node).not.toHaveProperty('availabilityZone');
  });

  it('leaves a node the shards do not list unchanged', () => {
    const node = { id: 'unknown' };

    expect(withShardMetadata([node], shards)[0]).toBe(node);
  });

  it('adds nothing for an 8.x reply, which carries neither field', () => {
    const olderShards: ClusterShard[] = [{ slots: [[0, 16383]], nodes: [{ id: 'primary-1', role: 'master' }] }];
    const node = { id: 'primary-1' };

    expect(withShardMetadata([node], olderShards)[0]).toBe(node);
  });

  it('returns the nodes as they are when there are no shards', () => {
    const nodes = [{ id: 'primary-1' }];

    expect(withShardMetadata(nodes, undefined)).toBe(nodes);
    expect(withShardMetadata(nodes, [])).toBe(nodes);
  });

  it('does not mutate the input nodes', () => {
    const node = { id: 'primary-1' };

    withShardMetadata([node], shards);

    expect(node).toEqual({ id: 'primary-1' });
  });
});

describe('readClusterShards', () => {
  it('returns the shards the client reports', async () => {
    const shards: ClusterShard[] = [{ slots: [], nodes: [], shardId: 'shard-1' }];

    await expect(readClusterShards({ getClusterShards: async () => shards })).resolves.toBe(shards);
  });

  it('returns undefined when the command fails', async () => {
    const client = { getClusterShards: jest.fn().mockRejectedValue(new Error('ERR unknown subcommand')) };

    await expect(readClusterShards(client)).resolves.toBeUndefined();
  });

  it('gives up on a read that never answers, so the nodes are not held back', async () => {
    jest.useFakeTimers();
    try {
      const client = { getClusterShards: jest.fn(() => new Promise<ClusterShard[]>(() => undefined)) };

      const reading = readClusterShards(client);
      await jest.advanceTimersByTimeAsync(CLUSTER_SHARDS_TIMEOUT_MS);

      await expect(reading).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns undefined when the client cannot read shards at all', async () => {
    await expect(readClusterShards({} as never)).resolves.toBeUndefined();
  });
});

describe('withConfiguredZones', () => {
  const zones = { '10.0.0.1:7001': 'us-east-1a', 'node-2.internal:7002': 'us-east-1b' };

  it('fills the zone of a node matched by ip:port, ignoring the cluster bus port', () => {
    const nodes = [{ id: 'primary-1', address: '10.0.0.1:7001@17001' }];

    expect(withConfiguredZones(nodes, zones)).toEqual([
      { id: 'primary-1', address: '10.0.0.1:7001@17001', availabilityZone: 'us-east-1a' },
    ]);
  });

  it('fills the zone of a node matched by its announced hostname and port', () => {
    const nodes = [{ id: 'replica-1', address: '10.0.0.2:7002@17002', hostname: 'Node-2.internal' }];

    expect(withConfiguredZones(nodes, zones)[0]).toMatchObject({ availabilityZone: 'us-east-1b' });
  });

  it('keeps the zone the server reported over a configured one', () => {
    const node = { id: 'primary-1', address: '10.0.0.1:7001@17001', availabilityZone: 'eu-west-1c' };

    expect(withConfiguredZones([node], zones)[0]).toBe(node);
  });

  it('decides per node: a node with no reported zone takes the map value next to one that reports its own', () => {
    const nodes = [
      { id: 'primary-1', address: '10.0.0.1:7001@17001', availabilityZone: 'eu-west-1c' },
      { id: 'replica-1', address: '10.0.0.2:7002@17002', hostname: 'node-2.internal' },
    ];

    expect(withConfiguredZones(nodes, zones).map((node) => node.availabilityZone)).toEqual(['eu-west-1c', 'us-east-1b']);
  });

  function zoneOf(address: string, map: unknown): string | undefined {
    const normalized = normalizeNodeAvailabilityZones(map);
    if (!normalized.ok) throw new Error(normalized.error);
    const node: { id: string; address: string; availabilityZone?: string } = { id: 'node', address };
    return withConfiguredZones([node], normalized.zones)[0].availabilityZone;
  }

  it('matches an IPv6 node whether the key was entered with or without brackets', () => {
    expect(zoneOf('2001:db8::1:7001@17001', { '[2001:DB8::1]:7001': 'us-east-1a' })).toBe('us-east-1a');
    expect(zoneOf('2001:db8::1:7001@17001', { '2001:db8::1:7001': 'us-east-1a' })).toBe('us-east-1a');
  });

  it('matches an IPv6 node whichever spelling of the address either side uses', () => {
    expect(zoneOf('2001:db8::1:7001@17001', { '2001:db8:0:0:0:0:0:1:7001': 'us-east-1a' })).toBe('us-east-1a');
    expect(zoneOf('[2001:db8:0:0:0:0:0:1]:7001@17001', { '2001:db8::1:7001': 'us-east-1a' })).toBe('us-east-1a');
    expect(zoneOf('2001:0db8:0000:0000:0000:0000:0000:0001:7001@17001', { '[2001:DB8::1]:7001': 'us-east-1a' })).toBe(
      'us-east-1a',
    );
    expect(zoneOf('2001:db8::2:7001@17001', { '2001:db8:0:0:0:0:0:1:7001': 'us-east-1a' })).toBeUndefined();
  });

  it('matches the host without regard to case', () => {
    expect(zoneOf('Node-7.Internal:7007@17007', { 'NODE-7.internal:7007': 'us-east-1a' })).toBe('us-east-1a');
  });

  it('matches on the port CLUSTER NODES shows, which is the TLS port on a TLS connection', () => {
    expect(zoneOf('10.0.0.8:6380@16380', { '10.0.0.8:6380': 'us-east-1a' })).toBe('us-east-1a');
    expect(zoneOf('10.0.0.8:6380@16380', { '10.0.0.8:6379': 'us-east-1a' })).toBeUndefined();
  });

  it('ignores a map entry that matches no node', () => {
    const nodes = [{ id: 'primary-1', address: '10.0.0.1:7001@17001' }];

    expect(withConfiguredZones(nodes, { ...zones, '10.9.9.9:7001': 'gone' })).toEqual([
      { id: 'primary-1', address: '10.0.0.1:7001@17001', availabilityZone: 'us-east-1a' },
    ]);
  });

  it('leaves a node with no configured zone as it is', () => {
    const node = { id: 'primary-3', address: '10.0.0.3:7003@17003' };

    expect(withConfiguredZones([node], zones)[0]).toBe(node);
    expect(node).not.toHaveProperty('availabilityZone');
  });

  it('does not match a node on the same host with another port', () => {
    const node = { id: 'primary-4', address: '10.0.0.1:7004@17004' };

    expect(withConfiguredZones([node], zones)[0]).toBe(node);
  });

  it('returns the nodes as they are when there is no map', () => {
    const nodes = [{ id: 'primary-1', address: '10.0.0.1:7001@17001' }];

    expect(withConfiguredZones(nodes, undefined)).toBe(nodes);
    expect(withConfiguredZones(nodes, {})).toBe(nodes);
  });

  it('does not mutate the input nodes', () => {
    const node = { id: 'primary-1', address: '10.0.0.1:7001@17001' };

    withConfiguredZones([node], zones);

    expect(node).toEqual({ id: 'primary-1', address: '10.0.0.1:7001@17001' });
  });
});
