import type { ClusterNodeRef } from '@betterdb/shared';
import { buildNodeDirectory, resolveNodeRef, type NodeDirectory } from '@app/cluster/node-ref';
import type { ClusterNode } from '@app/common/types/metrics.types';
import { MetricType, type AnomalyEvent } from './types';

const METRICS_WITHOUT_NODE: ReadonlySet<MetricType> = new Set([
  MetricType.CLUSTER_STATE,
  MetricType.RAFT_HEALTH,
  MetricType.SENTINEL_ENDPOINT_DRIFT,
  MetricType.SENTINEL_LOOP_STALL,
]);

const REPLICA_SUBJECT_METRICS: ReadonlySet<MetricType> = new Set([
  MetricType.REPLICA_SLOT_STATE,
  MetricType.REPLICATION_DIVERGENCE,
  MetricType.RESYNC_ESCALATION,
]);

const METRICS_WITHOUT_OWN_NODE: ReadonlySet<MetricType> = new Set([MetricType.TOPOLOGY_DIVERGENCE]);

interface NodeView {
  directory: NodeDirectory;
  readAt: number;
}

export class ClusterNodeViews {
  private readonly views = new Map<string, NodeView>();
  private readonly ownNodeIds = new Map<string, string>();

  remember(connectionId: string, nodes: readonly ClusterNode[], readAt: number): void {
    const directory = buildNodeDirectory(nodes);
    this.views.set(connectionId, { directory, readAt });
    if (directory.selfId) this.ownNodeIds.set(connectionId, directory.selfId);
  }

  forget(connectionId: string): void {
    this.views.delete(connectionId);
    this.ownNodeIds.delete(connectionId);
  }

  freshest(connectionIds: Iterable<string>): NodeDirectory | undefined {
    let freshest: NodeView | undefined;
    for (const connectionId of connectionIds) {
      const view = this.views.get(connectionId);
      if (view && (!freshest || view.readAt > freshest.readAt)) freshest = view;
    }
    return freshest?.directory;
  }

  ownNodeId(connectionId: string): string | undefined {
    return this.ownNodeIds.get(connectionId);
  }
}

function subjectOfDetector(
  subject: NonNullable<AnomalyEvent['nodeSubject']>,
  directory: NodeDirectory,
): ClusterNodeRef | undefined {
  const known = resolveNodeRef(directory, subject);
  if (known || !subject.address) return known;
  return { nodeId: subject.nodeId, address: subject.address.split('@')[0], role: 'unknown' };
}

export function nodeOfEvent(
  event: AnomalyEvent,
  directory: NodeDirectory | undefined,
  ownNodeId: string | undefined,
): ClusterNodeRef | undefined {
  if (event.node) return event.node;
  if (!directory || METRICS_WITHOUT_NODE.has(event.metricType)) return undefined;
  if (event.nodeSubject) return subjectOfDetector(event.nodeSubject, directory);
  if (event.replicaAddr && REPLICA_SUBJECT_METRICS.has(event.metricType)) {
    return resolveNodeRef(directory, { address: event.replicaAddr });
  }
  if (event.nodeAddr) return resolveNodeRef(directory, { address: event.nodeAddr });
  if (!ownNodeId || METRICS_WITHOUT_OWN_NODE.has(event.metricType)) return undefined;
  return resolveNodeRef(directory, { nodeId: ownNodeId });
}
