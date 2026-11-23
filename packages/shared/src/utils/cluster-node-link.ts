export type ClusterNodeRole = 'primary' | 'replica' | 'unknown';

export interface ClusterNodeRef {
  nodeId: string;
  address: string;
  role: ClusterNodeRole;
  shardId?: string;
  availabilityZone?: string;
}

export interface ServedClusterNodeRef extends ClusterNodeRef {
  collected: boolean;
  connectionId?: string;
}

export const CLUSTER_TAB_PARAM = 'tab';
export const CLUSTER_NODE_PARAM = 'node';
export const CLUSTER_NODES_TAB = 'nodes';

export function clusterNodePath(nodeId: string, connectionId?: string): string {
  const query = new URLSearchParams({ [CLUSTER_TAB_PARAM]: CLUSTER_NODES_TAB, [CLUSTER_NODE_PARAM]: nodeId });
  if (connectionId) query.set('connection', connectionId);
  return `/cluster?${query.toString()}`;
}

export function clusterNodeUrl(baseUrl: string, nodeId: string, connectionId?: string): string {
  return `${baseUrl.replace(/\/$/, '')}${clusterNodePath(nodeId, connectionId)}`;
}
