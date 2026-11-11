import type { ClusterShard } from '../common/types/metrics.types';
import { readClusterShards, withShardMetadata } from './shard-metadata';

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

  it('returns undefined when the client cannot read shards at all', async () => {
    await expect(readClusterShards({} as never)).resolves.toBeUndefined();
  });
});
