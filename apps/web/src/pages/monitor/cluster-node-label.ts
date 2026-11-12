import type { MonitorNodeDescriptor } from '../../api/monitor';

export function clusterNodeLabel(node: MonitorNodeDescriptor): string {
  const label = `${node.address} · ${node.role}`;
  return node.state === 'healthy' ? label : `${label} (${node.state})`;
}
