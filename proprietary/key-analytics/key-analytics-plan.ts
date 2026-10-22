import { hasOwnKeyAnalytics, type ConnectionStatus } from '@betterdb/shared';
import type { ConnectionRegistry } from '@app/connections/connection-registry.service';

export type CollectionPlan =
  | { kind: 'skip' }
  | { kind: 'single' }
  | { kind: 'cluster'; members: ConnectionStatus[] };

export function isScannable(connection: ConnectionStatus): boolean {
  return connection.isConnected && connection.connectionType !== 'external';
}

export function collectionPlan(connection: ConnectionStatus, all: ConnectionStatus[]): CollectionPlan {
  if (!hasOwnKeyAnalytics(connection.membership)) {
    return { kind: 'skip' };
  }
  if (connection.membership) {
    return { kind: 'single' };
  }
  const nodes = all.filter((candidate) => {
    const membership = candidate.membership;
    return membership?.seedId === connection.id && membership.source === 'cluster' && membership.retiredAt === undefined;
  });
  return nodes.length > 0 ? { kind: 'cluster', members: nodes.filter(isScannable) } : { kind: 'single' };
}

export interface ResolvedPlan {
  connection: ConnectionStatus | undefined;
  plan: CollectionPlan;
}

export function resolvePlan(registry: Pick<ConnectionRegistry, 'list'>, connectionId: string): ResolvedPlan {
  const connections = registry.list({ includeRetired: true });
  const connection = connections.find((candidate) => candidate.id === connectionId);
  return { connection, plan: connection ? collectionPlan(connection, connections) : { kind: 'single' } };
}

export function planForConnection(registry: Pick<ConnectionRegistry, 'list'>, connectionId: string): CollectionPlan {
  return resolvePlan(registry, connectionId).plan;
}
