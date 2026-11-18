import type { ClusterNodeRef } from '@betterdb/shared';
import { buildNodeDirectory, resolveNodeRef, type NodeDirectory } from '@app/cluster/node-ref';
import type { ClusterNode } from '@app/common/types/metrics.types';
import { isReadOnlyReplicaRole } from '@app/database/parsers/replication-info.parser';
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

interface ShardRead {
  read: () => readonly ClusterNode[];
  readAt: number;
}

interface NodeView {
  read: () => readonly ClusterNode[];
  readAt: number;
  own: () => readonly ClusterNode[];
  shards?: ShardRead;
  directory?: NodeDirectory;
}

function shardHolderOf(node: ClusterNode): string {
  return node.master && node.master !== '-' ? node.master : node.id;
}

function withShardDataOf(nodes: readonly ClusterNode[], source: readonly ClusterNode[]): ClusterNode[] {
  const known = new Map(source.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const shardId = node.shardId ?? known.get(shardHolderOf(node))?.shardId;
    const availabilityZone = node.availabilityZone ?? known.get(node.id)?.availabilityZone;
    return {
      ...node,
      ...(shardId ? { shardId } : {}),
      ...(availabilityZone ? { availabilityZone } : {}),
    };
  });
}

function laterShardRead(held: ShardRead | undefined, read: ShardRead | undefined): ShardRead | undefined {
  if (!held || !read) return held ?? read;
  return read.readAt >= held.readAt ? read : held;
}

function withShardsOf(view: NodeView, shards: ShardRead | undefined): NodeView {
  if (!shards || shards === view.shards) return view;
  const nodes = withShardDataOf(view.own(), shards.read());
  return { read: () => nodes, readAt: view.readAt, own: view.own, shards };
}

export interface ClusterNodeView {
  directory: NodeDirectory;
  readAt: number;
}

export interface OwnNodeRole {
  role: ClusterNodeRef['role'];
  readAt: number;
}

export class ClusterNodeViews {
  private readonly views = new Map<string, NodeView>();
  private readonly viewKeys = new Map<string, string>();
  private readonly ownNodeIds = new Map<string, string>();
  private readonly ownRoles = new Map<string, OwnNodeRole>();
  private readonly runIds = new Map<string, string>();
  private readonly outsideCluster = new Set<string>();

  remember(
    connectionId: string,
    viewKey: string,
    nodes: readonly ClusterNode[],
    readAt: number,
    describe: () => readonly ClusterNode[] = () => nodes,
    shardsRead = true,
  ): void {
    const ownNodeId = nodes.find((node) => node.flags.includes('myself'))?.id;
    if (ownNodeId) this.ownNodeIds.set(connectionId, ownNodeId);
    this.outsideCluster.delete(connectionId);
    if (this.viewKeys.get(connectionId) !== viewKey) {
      this.leaveView(connectionId);
      this.viewKeys.set(connectionId, viewKey);
    }
    const read: NodeView = {
      read: describe,
      readAt,
      own: describe,
      ...(shardsRead ? { shards: { read: describe, readAt } } : {}),
    };
    const held = this.views.get(viewKey);
    if (!held) {
      this.views.set(viewKey, read);
      return;
    }
    const latest = held.readAt > readAt ? held : read;
    this.views.set(viewKey, withShardsOf(latest, laterShardRead(held.shards, read.shards)));
  }

  rememberOwnRole(connectionId: string, role: ClusterNodeRef['role'] | undefined, readAt: number): void {
    this.outsideCluster.delete(connectionId);
    if (role) {
      this.ownRoles.set(connectionId, { role, readAt });
    } else {
      this.ownRoles.delete(connectionId);
    }
  }

  answersFromAnotherRun(connectionId: string, runId: string | undefined): boolean {
    if (!runId) return false;
    const last = this.runIds.get(connectionId);
    this.runIds.set(connectionId, runId);
    if (last === undefined || last === runId) return false;
    this.ownNodeIds.delete(connectionId);
    return true;
  }

  forget(connectionId: string): void {
    this.leaveView(connectionId);
    this.ownNodeIds.delete(connectionId);
    this.ownRoles.delete(connectionId);
    this.runIds.delete(connectionId);
    this.outsideCluster.delete(connectionId);
  }

  leaveCluster(connectionId: string): void {
    this.forget(connectionId);
    this.outsideCluster.add(connectionId);
  }

  isOutsideCluster(connectionId: string): boolean {
    return this.outsideCluster.has(connectionId);
  }

  view(viewKey: string): ClusterNodeView | undefined {
    const view = this.views.get(viewKey);
    if (!view) return undefined;
    view.directory ??= buildNodeDirectory(view.read());
    return { directory: view.directory, readAt: view.readAt };
  }

  keyOf(connectionId: string): string | undefined {
    return this.viewKeys.get(connectionId);
  }

  ownNodeId(connectionId: string): string | undefined {
    return this.ownNodeIds.get(connectionId);
  }

  ownRole(connectionId: string): OwnNodeRole | undefined {
    return this.ownRoles.get(connectionId);
  }

  connectionsOfNode(nodeId: string): string[] {
    return [...this.ownNodeIds].filter(([, own]) => own === nodeId).map(([connectionId]) => connectionId);
  }

  private leaveView(connectionId: string): void {
    const viewKey = this.viewKeys.get(connectionId);
    if (viewKey === undefined) return;
    this.viewKeys.delete(connectionId);
    for (const held of this.viewKeys.values()) {
      if (held === viewKey) return;
    }
    this.views.delete(viewKey);
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

function roleChangedTo(event: AnomalyEvent): ClusterNodeRef['role'] {
  return event.value === 1 ? 'primary' : 'replica';
}

export function nodeRoleOfInfo(role: string | undefined): ClusterNodeRef['role'] | undefined {
  if (role === 'master') return 'primary';
  return isReadOnlyReplicaRole(role) ? 'replica' : undefined;
}

export function nodeOfEvent(
  event: AnomalyEvent,
  directory: NodeDirectory | undefined,
  ownNodeId: string | undefined,
  roleKnown = true,
  ownRole?: ClusterNodeRef['role'],
): ClusterNodeRef | undefined {
  if (event.node) return event.node;
  const node = nodeInView(event, directory, ownNodeId);
  if (!node) return undefined;
  if (node.nodeId === ownNodeId) {
    const role = event.metricType === MetricType.REPLICATION_ROLE ? roleChangedTo(event) : ownRole;
    if (role) return { ...node, role };
  }
  return roleKnown ? node : { ...node, role: 'unknown' };
}

function nodeInView(
  event: AnomalyEvent,
  directory: NodeDirectory | undefined,
  ownNodeId: string | undefined,
): ClusterNodeRef | undefined {
  if (!directory || METRICS_WITHOUT_NODE.has(event.metricType)) return undefined;
  if (event.nodeSubject) return subjectOfDetector(event.nodeSubject, directory);
  if (event.replicaAddr && REPLICA_SUBJECT_METRICS.has(event.metricType)) {
    return resolveNodeRef(directory, { address: event.replicaAddr });
  }
  if (event.nodeAddr) return resolveNodeRef(directory, { address: event.nodeAddr });
  if (!ownNodeId || METRICS_WITHOUT_OWN_NODE.has(event.metricType)) return undefined;
  return resolveNodeRef(directory, { nodeId: ownNodeId });
}
