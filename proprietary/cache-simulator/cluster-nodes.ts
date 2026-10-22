import type { Logger } from '@nestjs/common';
import type { ConnectionStatus } from '@betterdb/shared';
import type { DatabasePort } from '@app/common/interfaces/database-port.interface';
import type { ConnectionRegistry } from '@app/connections/connection-registry.service';

export interface ScanNode {
  id: string;
  name: string;
  client: DatabasePort;
}

export function clusterNodes(
  registry: Pick<ConnectionRegistry, 'get'>,
  seed: ScanNode,
  members: ConnectionStatus[],
  logger: Pick<Logger, 'warn'>,
  label: string,
): ScanNode[] {
  const nodes = [seed];
  for (const member of members) {
    try {
      nodes.push({ id: member.id, name: member.name, client: registry.get(member.id) });
    } catch {
      logger.warn(`${label} skipped ${member.name}: the connection is no longer registered`);
    }
  }
  return nodes;
}

export async function primaryNodes(
  nodes: ScanNode[],
  logger: Pick<Logger, 'warn'>,
  label: string,
): Promise<ScanNode[]> {
  const views = await Promise.allSettled(nodes.map((node) => node.client.getClusterNodes()));
  return nodes.filter((node, index) => {
    const view = views[index];
    if (view.status === 'rejected') {
      logger.warn(
        `${label} could not read the cluster role of ${node.name}: ${view.reason instanceof Error ? view.reason.message : view.reason}`,
      );
      return false;
    }
    const self = view.value.find((entry) => entry.flags.includes('myself'));
    return self !== undefined && self.flags.includes('master') && self.slots.length > 0;
  });
}
