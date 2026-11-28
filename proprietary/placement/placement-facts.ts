import {
  PLACEMENT_EPOCH_WINDOW_MS,
  type PlacementGateFacts,
  type PlacementGateIncident,
  type PlacementGateNode,
  type PlacementGateSignal,
} from './placement-gate';

export const PLACEMENT_GATE_EVENT_TYPES: readonly string[] = [
  'cluster_state',
  'topology_divergence',
  'slot_migration_stuck',
  'orphaned_slot_keys',
  'ghost_membership',
  'failover_churn',
  'replication_role',
  'lagging_promotion',
  'persistence_child',
  'fork_memory_risk',
  'command_p99',
  'replication_divergence',
];

export interface PlacementNodeRead {
  id: string;
  address: string;
  role: 'master' | 'replica';
  state: PlacementGateNode['state'];
  shardId: string;
  collected: boolean;
  configEpoch: number;
}

export interface PlacementNodeFacts {
  nodes: PlacementNodeRead[];
  clusterStateOk: boolean | null;
  migrations: PlacementGateFacts['migrations'];
  persistence: PlacementGateFacts['persistence'];
  replication: PlacementGateFacts['replication'];
  pingP50Ms: PlacementGateFacts['pingP50Ms'];
}

export interface PlacementIncidentsRead {
  incidents: PlacementGateIncident[];
  historyFrom: number | null;
}

export interface PlacementFactsPort {
  placementOpenEvents(connectionId: string): Promise<PlacementGateSignal[]>;
  placementIncidents(connectionId: string): Promise<PlacementIncidentsRead>;
  readPlacementNodeFacts(connectionId: string, shardIds: string[]): Promise<PlacementNodeFacts>;
}

export type PlacementFactsContext = PlacementGateContext & { movedShardIds?: readonly string[] };

type PlacementGateContext = Pick<
  PlacementGateFacts,
  | 'budget'
  | 'paused'
  | 'supported'
  | 'sourceShardId'
  | 'targetShardIds'
  | 'moveCount'
  | 'sourceTriggerFiredAt'
  | 'quarantinedShardIds'
  | 'cooldownLeftSlots'
>;

interface EpochSeen {
  shardId: string;
  epoch: number;
  since: number;
  changedAt: number | null;
  seenAt: number;
}

export type PlacementEpochRead = Pick<PlacementNodeRead, 'id' | 'shardId' | 'configEpoch'>;

export class PlacementEpochs {
  private readonly seen = new Map<string, Map<string, EpochSeen>>();

  observe(
    seedId: string,
    nodes: readonly PlacementEpochRead[],
    now: number,
    movedShardIds: readonly string[] = [],
  ): Map<string, boolean | null> {
    const known = this.seen.get(seedId) ?? new Map<string, EpochSeen>();
    const next = new Map(
      [...known].filter(([, entry]) => now - entry.seenAt < PLACEMENT_EPOCH_WINDOW_MS),
    );
    const changed = new Map<string, boolean | null>();
    for (const node of nodes) {
      const before = known.get(node.id);
      const ours = before?.shardId === node.shardId && movedShardIds.includes(node.shardId);
      const entry: EpochSeen = !before
        ? {
            shardId: node.shardId,
            epoch: node.configEpoch,
            since: now,
            changedAt: null,
            seenAt: now,
          }
        : node.configEpoch > before.epoch
          ? {
              shardId: now >= before.seenAt ? node.shardId : before.shardId,
              epoch: node.configEpoch,
              since: before.since,
              changedAt: ours ? before.changedAt : now,
              seenAt: Math.max(now, before.seenAt),
            }
          : {
              ...before,
              shardId: now >= before.seenAt ? node.shardId : before.shardId,
              seenAt: Math.max(now, before.seenAt),
            };
      next.set(node.id, entry);
      if (entry.changedAt !== null && now - entry.changedAt < PLACEMENT_EPOCH_WINDOW_MS) {
        changed.set(node.id, true);
      } else {
        changed.set(node.id, now - entry.since >= PLACEMENT_EPOCH_WINDOW_MS ? false : null);
      }
    }
    this.seen.set(seedId, next);
    return changed;
  }

  seeds(): string[] {
    return [...this.seen.keys()];
  }

  has(seedId: string): boolean {
    return this.seen.has(seedId);
  }

  forget(seedId: string): void {
    this.seen.delete(seedId);
  }
}

export const PLACEMENT_PINGS = 10;
export const PLACEMENT_REPLICA_LAG_S = 1;

export async function pingP50(client: { ping(): Promise<unknown> }): Promise<number> {
  const times: number[] = [];
  for (let count = 0; count < PLACEMENT_PINGS; count++) {
    const started = performance.now();
    await client.ping();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const middle = times.length / 2;
  return (times[Math.floor(middle - 0.5)] + times[Math.ceil(middle - 0.5)]) / 2;
}

export function forkOf(
  persistence: Record<string, string> | undefined,
): { forkRunning: boolean } | null {
  if (!persistence || persistence.rdb_bgsave_in_progress === undefined) return null;
  return {
    forkRunning:
      persistence.rdb_bgsave_in_progress === '1' || persistence.aof_rewrite_in_progress === '1',
  };
}

export function replicasInSyncOf(
  replication: Record<string, string> | undefined,
  listedReplicas: number,
): { replicasInSync: boolean } | null {
  const count = Number(replication?.connected_slaves);
  if (!replication || !Number.isInteger(count)) return null;
  const replicas = Object.entries(replication)
    .filter(([key]) => /^slave\d+$/.test(key))
    .map(([, value]) => Object.fromEntries(value.split(',').map((pair) => pair.split('='))));
  const inSync = replicas.every(
    (replica) => replica.state === 'online' && Number(replica.lag) <= PLACEMENT_REPLICA_LAG_S,
  );
  return {
    replicasInSync: count === listedReplicas && replicas.length === listedReplicas && inSync,
  };
}

function clientAddressOf(address: string): string {
  return address.split('@')[0];
}

function withNodeIds(
  signals: readonly PlacementGateSignal[],
  nodes: readonly PlacementNodeRead[],
): PlacementGateSignal[] {
  const byAddress = new Map<string, string | null>();
  for (const node of nodes) {
    const address = clientAddressOf(node.address);
    byAddress.set(address, byAddress.has(address) ? null : node.id);
  }
  return signals.map((signal) =>
    signal.nodeId === null && signal.address
      ? { ...signal, nodeId: byAddress.get(clientAddressOf(signal.address)) ?? null }
      : signal,
  );
}

export interface PlacementClusterRead {
  openEvents: PlacementGateSignal[] | null;
  incidents: PlacementIncidentsRead | null;
  nodeFacts: PlacementNodeFacts | null;
  unreadable: string[];
}

export async function readPlacementCluster(
  port: PlacementFactsPort,
  seedId: string,
  shardIds: readonly string[],
  warn: (message: string) => void,
): Promise<PlacementClusterRead> {
  const unreadable: string[] = [];
  const wanted = [...new Set(shardIds)];
  const attempt = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      warn(
        `Could not read ${name} of ${seedId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      unreadable.push(name);
      return null;
    }
  };
  const [openEvents, incidents, nodeFacts] = await Promise.all([
    attempt('the open events', () => port.placementOpenEvents(seedId)),
    attempt('the open incidents', () => port.placementIncidents(seedId)),
    attempt('the cluster nodes', () => port.readPlacementNodeFacts(seedId, wanted)),
  ]);
  return { openEvents, incidents, nodeFacts, unreadable };
}

export async function readPlacementGateFacts(
  port: PlacementFactsPort,
  epochs: PlacementEpochs,
  seedId: string,
  context: PlacementFactsContext,
  now: number,
  warn: (message: string) => void = () => undefined,
): Promise<PlacementGateFacts> {
  const read = await readPlacementCluster(
    port,
    seedId,
    [context.sourceShardId, ...context.targetShardIds],
    warn,
  );
  return placementGateFactsOf(read, epochs, seedId, context, now);
}

export function placementGateFactsOf(
  read: PlacementClusterRead,
  epochs: PlacementEpochs,
  seedId: string,
  context: PlacementFactsContext,
  now: number,
): PlacementGateFacts {
  const { movedShardIds = [], ...gateContext } = context;
  const { openEvents, incidents, nodeFacts, unreadable } = read;
  const reads = nodeFacts?.nodes ?? [];
  const changed = nodeFacts
    ? epochs.observe(seedId, reads, now, movedShardIds)
    : new Map<string, boolean | null>();
  const nodes: PlacementGateNode[] = reads.map((node) => ({
    id: node.id,
    address: node.address,
    role: node.role,
    state: node.state,
    shardId: node.shardId,
    collected: node.collected,
    epochChanged: changed.get(node.id) ?? null,
  }));
  return {
    ...gateContext,
    nodes,
    clusterStateOk: nodeFacts ? nodeFacts.clusterStateOk : null,
    migrations: nodeFacts ? nodeFacts.migrations : 'unknown',
    openEvents: withNodeIds(openEvents ?? [], reads),
    incidents: (incidents?.incidents ?? []).map((incident) => ({
      ...incident,
      signals: withNodeIds(incident.signals, reads),
    })),
    incidentHistoryFrom: incidents?.historyFrom ?? null,
    persistence: nodeFacts?.persistence ?? {},
    replication: nodeFacts?.replication ?? {},
    pingP50Ms: nodeFacts?.pingP50Ms ?? {},
    unreadable: [...unreadable],
  };
}
