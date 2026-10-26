import type { Logger } from '@nestjs/common';
import type { DatabasePort } from '@app/common/interfaces/database-port.interface';
import type { ConnectionRegistry } from '@app/connections/connection-registry.service';
import type { ConnectionStatus } from '@betterdb/shared';

export interface ScanNode {
  name: string;
  client: DatabasePort;
  connectionId?: string;
  nodeId?: string;
}

export function clusterScanNodes(
  registry: ConnectionRegistry,
  seed: ScanNode,
  members: ConnectionStatus[],
  logger: Logger,
  label: string,
): ScanNode[] {
  const nodes = [seed];
  for (const member of members) {
    try {
      nodes.push({
        name: member.name,
        client: registry.get(member.id),
        connectionId: member.id,
        nodeId: member.membership?.nodeId,
      });
    } catch {
      logger.warn(`${label} skipped ${member.name}: the connection is no longer registered`);
    }
  }
  return nodes;
}

const CLUSTER_NODE_ID = /^[0-9a-f]{40}$/;

const validNodeId = (id: unknown): string | undefined => {
  const text = Buffer.isBuffer(id) ? id.toString() : id;
  return typeof text === 'string' && CLUSTER_NODE_ID.test(text) ? text : undefined;
};

const attempt = <T>(read: () => Promise<T>): Promise<T | undefined> =>
  Promise.resolve()
    .then(read)
    .catch(() => undefined);

async function clusterNodeId(node: ScanNode): Promise<string | undefined> {
  const reported = validNodeId(await attempt(() => node.client.call('CLUSTER', ['MYID'])));
  if (reported !== undefined) return reported;
  const view = await attempt(() => node.client.getClusterNodes());
  return validNodeId(view?.find((peer) => peer.flags.includes('myself'))?.id);
}

export async function primaryScanNodes(nodes: ScanNode[], logger: Logger, label: string): Promise<ScanNode[]> {
  const roles = await Promise.allSettled(nodes.map((node) => node.client.getRole()));
  const masters = nodes.filter((node, index) => {
    const role = roles[index];
    if (role.status === 'rejected') {
      logger.warn(`${label} could not read the role of ${node.name}: ${role.reason instanceof Error ? role.reason.message : role.reason}`);
      return false;
    }
    return role.value.role === 'master';
  });
  const ids = await Promise.all(masters.map((node) => clusterNodeId(node)));
  const seen = new Set<string>();
  const primaries: ScanNode[] = [];
  masters.forEach((node, index) => {
    const id = ids[index];
    if (id === undefined) {
      primaries.push(node);
      return;
    }
    if (seen.has(id)) {
      logger.warn(`${label} skipped ${node.name}: it is the same cluster node as an earlier connection`);
      return;
    }
    seen.add(id);
    primaries.push({ ...node, nodeId: id });
  });
  return primaries;
}
