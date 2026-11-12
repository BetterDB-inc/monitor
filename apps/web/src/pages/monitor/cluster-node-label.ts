import type { MonitorNodeDescriptor } from '../../api/monitor';

export function clusterNodeLabel(node: Pick<MonitorNodeDescriptor, 'address' | 'role' | 'state'>): string {
  const label = `${node.address} · ${node.role}`;
  return node.state === 'healthy' ? label : `${label} (${node.state})`;
}
