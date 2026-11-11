import type { NodeAvailabilityZones } from '@betterdb/shared';
import type { ClusterShard } from '../common/types/metrics.types';
import { withTimeout } from '../common/utils/with-timeout';
import { parseNodeAddress } from '../topology/membership-diff';

export const CLUSTER_SHARDS_TIMEOUT_MS = 5_000;

export interface ShardMetadata {
  availabilityZone?: string;
  shardId?: string;
}

export interface ClusterShardsReader {
  getClusterShards(): Promise<ClusterShard[]>;
}

export async function readClusterShards(client: ClusterShardsReader): Promise<ClusterShard[] | undefined> {
  try {
    return await withTimeout(client.getClusterShards(), CLUSTER_SHARDS_TIMEOUT_MS);
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

interface ZonedNode {
  address: string;
  hostname?: string;
  availabilityZone?: string;
}

function configuredZone(node: ZonedNode, zones: NodeAvailabilityZones): string | undefined {
  const parsed = parseNodeAddress(node.address);
  if (!parsed) {
    return undefined;
  }
  const byAddress = zones[`${parsed.host}:${parsed.port}`.toLowerCase()];
  if (byAddress || !node.hostname) {
    return byAddress;
  }
  return zones[`${node.hostname}:${parsed.port}`.toLowerCase()];
}

export function withConfiguredZones<T extends ZonedNode>(nodes: T[], zones: NodeAvailabilityZones | undefined): T[] {
  if (!zones || Object.keys(zones).length === 0) {
    return nodes;
  }
  return nodes.map((node) => {
    if (node.availabilityZone) {
      return node;
    }
    const availabilityZone = configuredZone(node, zones);
    return availabilityZone ? { ...node, availabilityZone } : node;
  });
}
