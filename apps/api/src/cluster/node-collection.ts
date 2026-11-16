import { parseNodeAddress } from '../topology/membership-diff';

export interface NodeCollection {
  collected: boolean;
  connectionId?: string;
}

interface CollectableNode {
  address: string;
  flags: readonly string[];
  hostname?: string;
}

export function collectionOf(
  node: CollectableNode,
  viewingConnectionId: string | null,
  findIdByHostPort: (host: string, port: number) => string | null,
): NodeCollection {
  const address = parseNodeAddress(node.address);
  const connectionId =
    (address ? findIdByHostPort(address.host, address.port) : null) ??
    (address && node.hostname ? findIdByHostPort(node.hostname, address.port) : null) ??
    (node.flags.includes('myself') ? viewingConnectionId : null);
  return connectionId ? { collected: true, connectionId } : { collected: false };
}
