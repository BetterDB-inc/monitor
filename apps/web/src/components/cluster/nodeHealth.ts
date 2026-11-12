import { clusterNodeState } from '@betterdb/shared';
import type { ClusterNode } from '../../types/metrics';

export type GraphNodeHealth = 'healthy' | 'suspect' | 'unhealthy';

export function graphNodeHealth(node: Pick<ClusterNode, 'flags' | 'linkState'>): GraphNodeHealth {
  const state = clusterNodeState(node.flags);
  if (state === 'failed' || node.linkState !== 'connected') return 'unhealthy';
  return state === 'suspect' ? 'suspect' : 'healthy';
}
