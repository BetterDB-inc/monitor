import { hasOwnKeyAnalytics, type ConnectionStatus } from '@betterdb/shared';

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
