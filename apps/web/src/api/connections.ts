import { fetchApi } from './client';

export interface ConnectClusterNodeResult {
  id: string;
  created: boolean;
}

export const connectionsApi = {
  connectClusterNode: (connectionId: string, nodeId: string) =>
    fetchApi<ConnectClusterNodeResult>(
      `/connections/${encodeURIComponent(connectionId)}/nodes/${encodeURIComponent(nodeId)}/connect`,
      { method: 'POST' },
    ),
};
