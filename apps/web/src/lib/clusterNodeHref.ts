import { CONNECTION_PARAM } from './connectionParam';

export function nodeHref(nodeId: string, connectionId?: string): string {
  const params = new URLSearchParams();
  if (connectionId) params.set(CONNECTION_PARAM, connectionId);
  params.set('tab', 'nodes');
  params.set('node', nodeId);
  return `/cluster?${params.toString()}`;
}
