import { nodeAddressKeys, type ClusterNodeRef, type ClusterNodeRole } from '@betterdb/shared';
import type { ClusterNode } from '../common/types/metrics.types';

export type NodeSubject = { nodeId: string } | { address: string };

export interface NodeDirectory {
  byId: Map<string, ClusterNodeRef>;
  byAddress: Map<string, ClusterNodeRef>;
  selfId?: string;
}

const REPLICA_FLAGS = ['slave', 'replica'];

function roleOf(flags: readonly string[]): ClusterNodeRole {
  if (flags.includes('master')) return 'primary';
  if (flags.some((flag) => REPLICA_FLAGS.includes(flag))) return 'replica';
  return 'unknown';
}

export function toClusterNodeRef(node: ClusterNode): ClusterNodeRef {
  return {
    nodeId: node.id,
    address: node.address.split('@')[0],
    role: roleOf(node.flags),
    ...(node.shardId ? { shardId: node.shardId } : {}),
    ...(node.availabilityZone ? { availabilityZone: node.availabilityZone } : {}),
  };
}

export function buildNodeDirectory(nodes: readonly ClusterNode[]): NodeDirectory {
  const directory: NodeDirectory = { byId: new Map(), byAddress: new Map() };
  for (const node of nodes) {
    const ref = toClusterNodeRef(node);
    directory.byId.set(node.id, ref);
    for (const key of nodeAddressKeys(node)) {
      directory.byAddress.set(key, ref);
    }
    if (node.flags.includes('myself')) {
      directory.selfId = node.id;
    }
  }
  return directory;
}

export function resolveNodeRef(
  directory: NodeDirectory | undefined,
  subject: NodeSubject | undefined,
): ClusterNodeRef | undefined {
  if (!directory || !subject) return undefined;
  if ('nodeId' in subject) return directory.byId.get(subject.nodeId);
  const [key] = nodeAddressKeys({ address: subject.address });
  return key ? directory.byAddress.get(key) : undefined;
}
