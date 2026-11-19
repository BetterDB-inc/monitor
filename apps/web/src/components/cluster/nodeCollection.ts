import type { Connection } from '../../hooks/useConnection';

export interface NodeCollection {
  collected: boolean;
  connectionId?: string;
}

export function nodeCollectionOf(
  nodes: ReadonlyArray<{ id: string; collected?: boolean; connectionId?: string }> | null | undefined,
): Map<string, NodeCollection> {
  const collection = new Map<string, NodeCollection>();
  for (const node of nodes ?? []) {
    if (typeof node.collected !== 'boolean') continue;
    collection.set(node.id, {
      collected: node.collected,
      ...(node.connectionId ? { connectionId: node.connectionId } : {}),
    });
  }
  return collection;
}

export type ClusterConnectionRef = Pick<Connection, 'id' | 'dialsDataNodes'>;
