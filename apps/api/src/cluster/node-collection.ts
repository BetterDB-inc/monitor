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
  findIdReadingNode: (nodeId: string) => string | null = () => null,
): NodeCollection {
  const address = parseNodeAddress(node.address);
  const readingNodeAt = (host: string, port: number): string | null => {
    const found = findIdByHostPort(host, port);
    if (!found) return null;
    const ownNodeId = ownNodeIdOf(found);
    return ownNodeId && ownNodeId !== node.id ? null : found;
  };
  const connectionId =
    findIdReadingNode(node.id) ??
    (address ? readingNodeAt(address.host, address.port) : null) ??
    (address && node.hostname ? readingNodeAt(node.hostname, address.port) : null) ??
    (node.flags.includes('myself') ? viewingConnectionId : null);
  return connectionId ? { collected: true, connectionId } : { collected: false };
}

interface ConnectionLookup {
  findIdByHostPort(host: string, port: number): string | null;
  findIdObservingNode(nodeId: string): string | null;
  getObservedNodeId(connectionId: string): string | undefined;
  isOutsideCluster(connectionId: string): boolean;
  getConfig(connectionId: string): { membership?: { nodeId?: string } } | null | undefined;
}

export function collectionAmong(
  node: CollectableNode,
  viewingConnectionId: string | null,
  connections: ConnectionLookup,
): NodeCollection {
  return collectionOf(
    node,
    viewingConnectionId,
    (host, port) => {
      const found = connections.findIdByHostPort(host, port);
      return found && connections.isOutsideCluster(found) ? null : found;
    },
    (id) => connections.getObservedNodeId(id) ?? connections.getConfig(id)?.membership?.nodeId,
    (nodeId) => connections.findIdObservingNode(nodeId),
  );
}
