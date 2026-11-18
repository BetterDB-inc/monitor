export const FAILOVER_SHARD = 1;
const SEED_INDEX = 0;

interface Address {
  host: string;
  port: number;
}

const addressOf = (node: Address): string => `${node.host}:${node.port}`;

export function hangLimit(nodes: number, nodesPerShard: number, failover: boolean): number {
  return nodes - 1 - (failover ? nodesPerShard : 0);
}

export function pickHungNodes(
  nodes: ReadonlyArray<{ index: number; shard: number }>,
  count: number,
  failoverShard: number | null,
): number[] {
  const candidates = nodes
    .filter((node) => node.index !== SEED_INDEX && node.shard !== failoverShard)
    .map((node) => node.index)
    .reverse();
  if (count > candidates.length) {
    throw new Error(`${count} nodes to hang, the cluster has ${candidates.length} that can`);
  }
  return candidates.slice(0, count);
}

export function downOutsideHung(
  connections: ReadonlyArray<Address & { isConnected: boolean }>,
  hungNodes: ReadonlyArray<Address>,
): number {
  const hung = new Set(hungNodes.map(addressOf));
  return connections.filter((connection) => !connection.isConnected && !hung.has(addressOf(connection))).length;
}
