import { parseNodeAddress } from '../topology/membership-diff';

export interface NodeCollection {
  collected: boolean;
  connectionId?: string;
}

interface CollectableNode {
  id: string;
  address: string;
  flags: readonly string[];
  hostname?: string;
}

export function collectionOf(
  node: CollectableNode,
  viewingConnectionId: string | null,
  findIdByHostPort: (host: string, port: number) => string | null,
  ownNodeIdOf: (connectionId: string) => string | undefined = () => undefined,
): NodeCollection {
  const address = parseNodeAddress(node.address);
  const readingNodeAt = (host: string, port: number): string | null => {
    const found = findIdByHostPort(host, port);
    if (!found) return null;
    const ownNodeId = ownNodeIdOf(found);
    return ownNodeId && ownNodeId !== node.id ? null : found;
  };
  const connectionId =
    (address ? readingNodeAt(address.host, address.port) : null) ??
    (address && node.hostname ? readingNodeAt(node.hostname, address.port) : null) ??
    (node.flags.includes('myself') ? viewingConnectionId : null);
  return connectionId ? { collected: true, connectionId } : { collected: false };
}
