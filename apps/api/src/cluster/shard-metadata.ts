import type { ClusterShard } from '../common/types/metrics.types';

export interface ShardMetadata {
  availabilityZone?: string;
  shardId?: string;
}

export interface ClusterShardsReader {
  getClusterShards(): Promise<ClusterShard[]>;
}

export async function readClusterShards(client: ClusterShardsReader): Promise<ClusterShard[] | undefined> {
  try {
    return await client.getClusterShards();
  } catch {
    return undefined;
  }
}

function indexShardMetadata(shards: ClusterShard[]): Map<string, ShardMetadata> {
  const byNodeId = new Map<string, ShardMetadata>();
  for (const shard of shards) {
    for (const node of shard.nodes) {
      const metadata: ShardMetadata = {
        ...(node.availabilityZone ? { availabilityZone: node.availabilityZone } : {}),
        ...(shard.shardId ? { shardId: shard.shardId } : {}),
      };
      if (metadata.availabilityZone || metadata.shardId) {
        byNodeId.set(node.id, metadata);
      }
    }
  }
  return byNodeId;
}

export function withShardMetadata<T extends { id: string }>(
  nodes: T[],
  shards: ClusterShard[] | undefined,
): Array<T & ShardMetadata> {
  if (!shards || shards.length === 0) {
    return nodes;
  }
  const byNodeId = indexShardMetadata(shards);
  if (byNodeId.size === 0) {
    return nodes;
  }
  return nodes.map((node) => {
    const metadata = byNodeId.get(node.id);
    return metadata ? { ...node, ...metadata } : node;
  });
}
