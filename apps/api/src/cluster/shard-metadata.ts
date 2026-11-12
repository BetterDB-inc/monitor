import type Valkey from 'iovalkey';
import type { ClusterShard } from '../common/types/metrics.types';
import { withTimeout } from '../common/utils/with-timeout';
import { MetricsParser } from '../database/parsers/metrics.parser';

export const CLUSTER_SHARDS_TIMEOUT_MS = 5_000;

export interface ShardMetadata {
  availabilityZone?: string;
  shardId?: string;
}

export interface ClusterShardsReader {
  getClusterShards(): Promise<ClusterShard[]>;
  getClient(): Valkey;
}

function ownSocket(reader: ClusterShardsReader, timeoutMs: number): Valkey | undefined {
  try {
    return reader.getClient().duplicate({
      lazyConnect: true,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: timeoutMs,
      commandTimeout: timeoutMs,
      connectionName: 'BetterDB-Monitor-Shards',
    });
  } catch {
    return undefined;
  }
}

async function queryShards(socket: Valkey): Promise<ClusterShard[]> {
  await socket.connect();
  return MetricsParser.parseClusterShards((await socket.call('CLUSTER', 'SHARDS')) as unknown[]);
}

async function readOverOwnSocket(socket: Valkey, timeoutMs: number): Promise<ClusterShard[]> {
  socket.on('error', () => undefined);
  try {
    return await withTimeout(queryShards(socket), timeoutMs);
  } finally {
    socket.disconnect();
  }
}

export async function readClusterShards(
  reader: ClusterShardsReader,
  timeoutMs = CLUSTER_SHARDS_TIMEOUT_MS,
): Promise<ClusterShard[] | undefined> {
  try {
    const socket = ownSocket(reader, timeoutMs);
    if (socket) {
      return await readOverOwnSocket(socket, timeoutMs);
    }
    return await withTimeout(reader.getClusterShards(), timeoutMs);
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
