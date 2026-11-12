import { clusterNodeState } from '@betterdb/shared';
import type { ClusterNode } from '../../types/metrics';

export type GraphNodeHealth = 'healthy' | 'suspect' | 'unhealthy';

type NodeHealthInput = Pick<ClusterNode, 'flags' | 'linkState'>;

export function graphNodeHealth(node: NodeHealthInput): GraphNodeHealth {
  const state = clusterNodeState(node.flags);
  if (state === 'failed') return 'unhealthy';
  if (state === 'suspect') return 'suspect';
  return node.linkState === 'connected' ? 'healthy' : 'unhealthy';
}

export function graphNodeStatus(node: NodeHealthInput): string {
  const health = graphNodeHealth(node);
  const state = health === 'healthy' ? '' : `State: ${health}\n`;
  const link = node.linkState === 'connected' ? '' : `Link: ${node.linkState}\n`;
  return state + link;
}
