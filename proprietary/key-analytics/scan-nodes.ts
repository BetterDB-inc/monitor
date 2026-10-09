import type { Logger } from '@nestjs/common';
import type { DatabasePort } from '@app/common/interfaces/database-port.interface';
import type { ConnectionRegistry } from '@app/connections/connection-registry.service';
import type { ConnectionStatus } from '@betterdb/shared';

export interface ScanNode {
  name: string;
  client: DatabasePort;
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
      nodes.push({ name: member.name, client: registry.get(member.id) });
    } catch {
      logger.warn(`${label} skipped ${member.name}: the connection is no longer registered`);
    }
  }
  return nodes;
}

export async function primaryScanNodes(nodes: ScanNode[], logger: Logger, label: string): Promise<ScanNode[]> {
  const roles = await Promise.allSettled(nodes.map((node) => node.client.getRole()));
  return nodes.filter((node, index) => {
    const role = roles[index];
    if (role.status === 'rejected') {
      logger.warn(`${label} could not read the role of ${node.name}: ${role.reason instanceof Error ? role.reason.message : role.reason}`);
      return false;
    }
    return role.value.role === 'master';
  });
}
