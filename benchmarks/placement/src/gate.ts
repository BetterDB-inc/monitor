import {
  DEFAULT_PLACEMENT_SETTINGS,
  type PlacementBlocker,
  type PlacementGatePurpose,
  type PlacementGateResult,
  type PlacementSettings,
} from '@betterdb/shared';
import {
  type PlacementFactsPort,
  type PlacementGateIncident,
  type PlacementGateSignal,
  type PlacementNodeFacts,
  type PlacementNodeRead,
  PlacementEpochs,
  placementGate,
  readPlacementGateFacts,
} from './product';

const MINUTE_MS = 60_000;
export const GATE_NOW = Date.UTC(2026, 10, 25, 12, 0);
export const GATE_FIRED_AT = GATE_NOW - 10 * MINUTE_MS;

export type GatePlace =
  | 'source primary'
  | 'source replica'
  | 'target primary'
  | 'target replica'
  | 'unrelated primary';

export const GATE_PLACES: Record<GatePlace, string> = {
  'source primary': 's1',
  'source replica': 's2',
  'target primary': 't1',
  'target replica': 't2',
  'unrelated primary': 'u1',
};

const SHARDS = ['s1', 't1', 'u1'];

export interface GateWorld {
  uncollected: Set<string>;
  failed: Set<string>;
  epochs: Map<string, number>;
  events: PlacementGateSignal[];
  incidents: PlacementGateIncident[];
  forks: Set<string>;
  pings: Map<string, number | null>;
  outOfSync: Set<string>;
  clusterStateOk: boolean | null;
  migrations: PlacementNodeFacts['migrations'];
  jobsUsed: number;
  unreadable: Set<keyof PlacementFactsPort>;
  firedAt: number | null;
}

export function quietWorld(): GateWorld {
  return {
    uncollected: new Set(),
    failed: new Set(),
    epochs: new Map(),
    events: [],
    incidents: [],
    forks: new Set(),
    pings: new Map(),
    outOfSync: new Set(),
    clusterStateOk: true,
    migrations: 'none',
    jobsUsed: 0,
    unreadable: new Set(),
    firedAt: GATE_FIRED_AT,
  };
}

function nodesOf(world: GateWorld): PlacementNodeRead[] {
  return SHARDS.flatMap((shardId) =>
    [shardId, shardId.replace('1', '2')].map((id) => ({
      id,
      address: `${id}:6379`,
      role: id === shardId ? ('master' as const) : ('replica' as const),
      state: world.failed.has(id) ? ('failed' as const) : ('healthy' as const),
      shardId,
      collected: !world.uncollected.has(id),
      configEpoch: world.epochs.get(id) ?? 1,
    })),
  );
}

function portOf(world: GateWorld): PlacementFactsPort {
  const fail = (method: keyof PlacementFactsPort) => {
    if (world.unreadable.has(method)) throw new Error('timed out');
  };
  return {
    placementOpenEvents: async () => {
      fail('placementOpenEvents');
      return world.events;
    },
    placementIncidents: async () => {
      fail('placementIncidents');
      return world.incidents;
    },
    readPlacementNodeFacts: async (_seedId, shardIds) => {
      fail('readPlacementNodeFacts');
      const nodes = nodesOf(world);
      const read = nodes.filter((node) => shardIds.includes(node.shardId));
      const facts: PlacementNodeFacts = {
        nodes,
        clusterStateOk: world.clusterStateOk,
        migrations: world.migrations,
        persistence: {},
        replication: {},
        pingP50Ms: {},
      };
      for (const node of read) {
        facts.persistence[node.id] = { forkRunning: world.forks.has(node.id) };
        facts.pingP50Ms[node.id] = world.pings.has(node.id)
          ? (world.pings.get(node.id) ?? null)
          : 1;
        if (node.role === 'master') {
          facts.replication[node.id] = {
            replicasInSync: !read.some(
              (replica) => replica.shardId === node.id && world.outOfSync.has(replica.id),
            ),
          };
        }
      }
      return facts;
    },
  };
}

export async function judgeGate(
  world: GateWorld,
  purpose: PlacementGatePurpose = 'approve',
  settings: PlacementSettings = DEFAULT_PLACEMENT_SETTINGS,
): Promise<PlacementGateResult> {
  const epochs = new PlacementEpochs();
  epochs.observe('bench', nodesOf({ ...world, epochs: new Map() }), GATE_NOW - 10 * MINUTE_MS);
  const facts = await readPlacementGateFacts(
    portOf(world),
    epochs,
    'bench',
    {
      budget: { jobsUsed: world.jobsUsed, bytesUsed: 0 },
      paused: false,
      supported: true,
      sourceShardId: 's1',
      targetShardIds: ['t1'],
      sourceTriggerFiredAt: world.firedAt,
      quarantinedShardIds: [],
      cooldownLeftSlots: null,
    },
    GATE_NOW,
  );
  return placementGate(facts, settings, GATE_NOW, purpose);
}

export const describeBlockers = (blockers: PlacementBlocker[]) =>
  blockers.length === 0
    ? 'none'
    : blockers
        .map((each) => `${each.kind}/${each.scope}${each.nodeId ? `/${each.nodeId}` : ''}`)
        .join(', ');

export interface NodeBlockerCase {
  variant: string;
  kind: PlacementBlocker['kind'];
  places: GatePlace[];
  raise: (world: GateWorld, nodeId: string) => void;
}

const event =
  (metricType: string, openedAt = GATE_NOW - 30 * MINUTE_MS) =>
  (world: GateWorld, nodeId: string) => {
    world.events.push({ metricType, nodeId, openedAt });
  };

const ALL_PLACES = Object.keys(GATE_PLACES) as GatePlace[];
const PRIMARIES: GatePlace[] = ['source primary', 'target primary', 'unrelated primary'];

export const NODE_BLOCKER_CASES: NodeBlockerCase[] = [
  {
    variant: 'open failover_churn event',
    kind: 'failover',
    places: ALL_PLACES,
    raise: event('failover_churn'),
  },
  {
    variant: 'open replication_role event',
    kind: 'failover',
    places: ALL_PLACES,
    raise: event('replication_role'),
  },
  {
    variant: 'open persistence_child event',
    kind: 'fork',
    places: ALL_PLACES,
    raise: event('persistence_child'),
  },
  {
    variant: 'fork in INFO persistence',
    kind: 'fork',
    places: ALL_PLACES,
    raise: (world, id) => world.forks.add(id),
  },
  {
    variant: 'open command_p99 event',
    kind: 'latency',
    places: ALL_PLACES,
    raise: event('command_p99'),
  },
  {
    variant: 'PING median at 120 ms',
    kind: 'latency',
    places: ALL_PLACES,
    raise: (world, id) => world.pings.set(id, 120),
  },
  {
    variant: 'open replication_divergence event on a replica',
    kind: 'replication_divergence',
    places: ['source replica', 'target replica'],
    raise: event('replication_divergence'),
  },
  {
    variant: 'open incident with a memory_used signal',
    kind: 'incident',
    places: ALL_PLACES,
    raise: (world, nodeId) =>
      world.incidents.push({
        recovery: 'active',
        patterns: [],
        signals: [{ metricType: 'memory_used', nodeId, openedAt: GATE_NOW - 30 * MINUTE_MS }],
      }),
  },
  {
    variant: 'open incident of the node_failover pattern',
    kind: 'failover',
    places: PRIMARIES,
    raise: (world, nodeId) =>
      world.incidents.push({
        recovery: 'recovering',
        patterns: ['node_failover'],
        signals: [{ metricType: 'replication_role', nodeId, openedAt: GATE_NOW - 30 * MINUTE_MS }],
      }),
  },
];
