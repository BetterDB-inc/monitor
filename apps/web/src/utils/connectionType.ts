import type { Connection } from '../hooks/useConnection';

type WithType = Pick<Connection, 'connectionType'> | null | undefined;
type WithMembership = Pick<Connection, 'membership'> | null | undefined;

export function isExternalConnection(connection: WithType): boolean {
  return connection?.connectionType === 'external';
}

export function connectionTypeSuffix(connection: WithType): string {
  if (connection?.connectionType === 'agent') {
    return ' · via agent';
  }
  if (connection?.connectionType === 'external') {
    return ' · OTLP push';
  }
  return ' · direct';
}

export function isRetiredMember(connection: WithMembership): boolean {
  return connection?.membership?.retiredAt !== undefined;
}

export function isClusterChild(connection: WithMembership): boolean {
  return connection?.membership !== undefined;
}

export function orderWithMembers(
  connections: Connection[],
): Array<{ connection: Connection; depth: 0 | 1 }> {
  const ids = new Set(connections.map((c) => c.id));
  const childrenBySeed = new Map<string, Connection[]>();
  const topLevel: Connection[] = [];
  for (const connection of connections) {
    const seedId = connection.membership?.seedId;
    if (seedId && ids.has(seedId)) {
      childrenBySeed.set(seedId, [...(childrenBySeed.get(seedId) ?? []), connection]);
    } else {
      topLevel.push(connection);
    }
  }
  const result: Array<{ connection: Connection; depth: 0 | 1 }> = [];
  for (const connection of topLevel) {
    result.push({ connection, depth: 0 });
    const children = childrenBySeed.get(connection.id) ?? [];
    const active = children.filter((c) => !isRetiredMember(c));
    const retired = children.filter((c) => isRetiredMember(c));
    for (const child of [...active, ...retired]) {
      result.push({ connection: child, depth: 1 });
    }
  }
  return result;
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}
