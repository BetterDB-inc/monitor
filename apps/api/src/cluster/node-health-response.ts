import type { ClusterNodeState } from '@betterdb/shared';

export function withHealthy<T extends { state: ClusterNodeState }>(node: T): T & { healthy: boolean } {
  return { ...node, healthy: node.state === 'healthy' };
}
