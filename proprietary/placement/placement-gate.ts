import type {
  PlacementBlocker,
  PlacementBlockerKind,
  PlacementBlockerScope,
  PlacementGatePurpose,
  PlacementGateResult,
  PlacementMaintenanceWindow,
  PlacementSettings,
} from '@betterdb/shared';

export const PLACEMENT_LATENCY_FLOOR_MS = 50;
export const PLACEMENT_EPOCH_WINDOW_MS = 5 * 60_000;

export interface PlacementGateNode {
  id: string;
  address: string;
  role: 'master' | 'replica';
  state: 'healthy' | 'suspect' | 'failed';
  shardId: string;
  collected: boolean;
  epochChanged: boolean | null;
}

export interface PlacementGateSignal {
  metricType: string;
  nodeId: string | null;
  address?: string;
  openedAt: number;
}

export interface PlacementGateIncident {
  recovery: string;
  patterns: string[];
  signals: PlacementGateSignal[];
}

export interface PlacementGateFacts {
  nodes: PlacementGateNode[];
  clusterStateOk: boolean | null;
  migrations: 'none' | 'running' | 'unknown';
  openEvents: PlacementGateSignal[];
  incidents: PlacementGateIncident[];
  persistence: Record<string, { forkRunning: boolean } | null>;
  replication: Record<string, { replicasInSync: boolean } | null>;
  pingP50Ms: Record<string, number | null>;
  budget: { jobsUsed: number; bytesUsed: number };
  paused: boolean;
  supported: boolean;
  sourceShardId: string;
  targetShardIds: string[];
  sourceTriggerFiredAt: number | null;
  quarantinedShardIds: string[];
  cooldownLeftSlots: number | null;
  unreadable: string[];
}

const CLUSTER_EVENTS: Record<string, PlacementBlockerKind> = {
  cluster_state: 'cluster_state',
  topology_divergence: 'topology_divergence',
  slot_migration_stuck: 'slot_migration_stuck',
  orphaned_slot_keys: 'orphaned_slot_keys',
  ghost_membership: 'ghost_membership',
};

const NODE_EVENTS: Record<string, PlacementBlockerKind> = {
  failover_churn: 'failover',
  replication_role: 'failover',
  lagging_promotion: 'failover',
  persistence_child: 'fork',
  fork_memory_risk: 'fork',
  command_p99: 'latency',
};

const REPLICA_EVENTS: Record<string, PlacementBlockerKind> = {
  replication_divergence: 'replication_divergence',
};

const SOURCE_SYMPTOMS = new Set(['command_p99', 'load_saturation', 'cpu_utilization']);

const INCIDENT_IGNORED = new Set([
  'hot_shard',
  'reshard_shard_skew',
  'slot_migration',
  'placement_action',
  'placement_rollback',
]);

const OPEN_RECOVERY = new Set(['active', 'recovering', 'degraded', 'unknown']);

const ROLLBACK_KINDS = new Set<PlacementBlockerKind>([
  'unhealthy_node',
  'migration_running',
  'cluster_state',
  'topology_divergence',
  'failover',
  'fork',
  'latency',
  'unknown',
]);

const AUTO_ONLY = new Set<PlacementBlockerKind>(['coverage', 'outside_window', 'quarantined']);

const DAY_MS = 24 * 60 * 60_000;

export function insideMaintenanceWindow(
  windows: readonly PlacementMaintenanceWindow[],
  now: number,
): boolean {
  if (windows.length === 0) return true;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return windows.some((window) => {
    const [hours, minutes] = window.start.split(':').map(Number);
    const offset = (hours * 60 + minutes) * 60_000;
    return [today, today - DAY_MS].some((day) => {
      const start = day + offset;
      return (
        window.days.includes(new Date(day).getUTCDay()) &&
        now >= start &&
        now < start + window.durationMinutes * 60_000
      );
    });
  });
}

function sameBlocker(a: PlacementBlocker, b: PlacementBlocker): boolean {
  return a.kind === b.kind && a.scope === b.scope && a.nodeId === b.nodeId;
}

export function placementGate(
  facts: PlacementGateFacts,
  settings: PlacementSettings,
  now: number,
  purpose: PlacementGatePurpose,
): PlacementGateResult {
  const blockers: PlacementBlocker[] = [];
  const warnings: PlacementBlocker[] = [];
  const nodes = new Map(facts.nodes.map((node) => [node.id, node]));
  const byAddress = new Map(facts.nodes.map((node) => [node.address, node.id]));
  const named = (signal: PlacementGateSignal): PlacementGateSignal =>
    signal.nodeId === null && signal.address
      ? { ...signal, nodeId: byAddress.get(signal.address) ?? null }
      : signal;
  const openEvents = facts.openEvents.map(named);
  const incidents = facts.incidents.map((incident) => ({
    ...incident,
    signals: incident.signals.map(named),
  }));
  const name = (nodeId: string) => nodes.get(nodeId)?.address ?? nodeId;
  const raise = (
    kind: PlacementBlockerKind,
    scope: PlacementBlockerScope,
    detail: string,
    nodeId?: string,
  ) => {
    const blocker: PlacementBlocker = nodeId
      ? { kind, scope, nodeId, detail }
      : { kind, scope, detail };
    if (purpose === 'rollback') {
      if (!ROLLBACK_KINDS.has(kind) || (kind === 'latency' && scope === 'source')) return;
    }
    const list = AUTO_ONLY.has(kind) && purpose !== 'auto' ? warnings : blockers;
    if (purpose === 'rollback' && list === warnings) return;
    if (!list.some((each) => sameBlocker(each, blocker))) list.push(blocker);
  };

  for (const read of facts.unreadable) raise('unknown', 'cluster', `Could not read ${read}.`);

  for (const node of facts.nodes) {
    if (node.state !== 'healthy') {
      raise(
        'unhealthy_node',
        'cluster',
        `${node.address} is ${node.state === 'failed' ? 'failed' : 'suspected of failing'}.`,
        node.id,
      );
    }
  }
  if (facts.migrations === 'running') {
    raise('migration_running', 'cluster', 'A slot migration is running.');
  } else if (facts.migrations === 'unknown') {
    raise('unknown', 'cluster', 'Could not confirm that no slot migration is running.');
  }
  if (facts.clusterStateOk === false) {
    raise('cluster_state', 'cluster', 'CLUSTER INFO reports the cluster state is not ok.');
  } else if (facts.clusterStateOk === null) {
    raise('unknown', 'cluster', 'Could not read CLUSTER INFO.');
  }
  for (const event of openEvents) {
    const kind = CLUSTER_EVENTS[event.metricType];
    if (kind) raise(kind, 'cluster', `An open ${event.metricType} event.`);
  }
  if (
    facts.budget.jobsUsed >= settings.maxMigrationsPerHour ||
    facts.budget.bytesUsed >= settings.maxBytesPerHour
  ) {
    raise('budget', 'cluster', 'The hourly migration budget is used up.');
  }
  if (facts.paused) raise('paused', 'cluster', 'An admin paused slot moves.');
  if (!facts.supported)
    raise('unsupported', 'cluster', 'This cluster does not support slot moves.');

  const exempt = (scope: PlacementBlockerScope, signal: PlacementGateSignal) =>
    scope === 'source' &&
    SOURCE_SYMPTOMS.has(signal.metricType) &&
    facts.sourceTriggerFiredAt !== null &&
    signal.openedAt >= facts.sourceTriggerFiredAt;

  for (const event of openEvents) {
    const kind = NODE_EVENTS[event.metricType] ?? REPLICA_EVENTS[event.metricType];
    if (kind && event.nodeId === null) {
      raise(kind, 'cluster', `An open ${event.metricType} event on a node it does not name.`);
    }
  }

  for (const incident of incidents) {
    if (!OPEN_RECOVERY.has(incident.recovery)) continue;
    if (
      incident.signals.some(
        (signal) => signal.nodeId === null && !INCIDENT_IGNORED.has(signal.metricType),
      )
    ) {
      raise('unknown', 'cluster', 'An open incident involves a node it does not name.');
    }
  }

  const judgeShard = (scope: Exclude<PlacementBlockerScope, 'cluster'>, shardId: string) => {
    const members = facts.nodes.filter((node) => node.shardId === shardId);
    if (!members.some((node) => node.id === shardId && node.role === 'master')) {
      raise(
        'unknown',
        scope,
        `Shard ${name(shardId)} has no primary in the cluster view.`,
        shardId,
      );
    }
    for (const node of members) {
      const events = openEvents.filter((event) => event.nodeId === node.id);
      if (node.collected) {
        for (const event of events) {
          const kind =
            NODE_EVENTS[event.metricType] ??
            (node.role === 'replica' ? REPLICA_EVENTS[event.metricType] : undefined);
          if (kind && !exempt(scope, event)) {
            raise(kind, scope, `An open ${event.metricType} event on ${node.address}.`, node.id);
          }
        }
      } else if (node.epochChanged === true) {
        raise(
          'failover',
          scope,
          `The config epoch of ${node.address} changed in the last 5 minutes.`,
          node.id,
        );
      } else if (node.epochChanged === null) {
        raise('unknown', scope, `Could not tell whether ${node.address} failed over.`, node.id);
      }
      const persistence = facts.persistence[node.id];
      if (!persistence) {
        raise('unknown', scope, `Could not read INFO persistence on ${node.address}.`, node.id);
      } else if (persistence.forkRunning) {
        raise('fork', scope, `${node.address} is saving to disk in a fork.`, node.id);
      }
      const ping = facts.pingP50Ms[node.id];
      const limit = Math.max(PLACEMENT_LATENCY_FLOOR_MS, settings.abortLatencyMs);
      if (ping === null || ping === undefined) {
        raise('unknown', scope, `${node.address} did not answer PING.`, node.id);
      } else if (ping > limit) {
        raise(
          'latency',
          scope,
          `${node.address} answers PING in ${Math.round(ping)} ms, over ${limit} ms.`,
          node.id,
        );
      }
      for (const incident of incidents) {
        if (!OPEN_RECOVERY.has(incident.recovery)) continue;
        const signals = incident.signals.filter(
          (signal) =>
            signal.nodeId === node.id &&
            !INCIDENT_IGNORED.has(signal.metricType) &&
            !exempt(scope, signal),
        );
        if (signals.length === 0) continue;
        if (incident.patterns.includes('node_failover')) {
          raise('failover', scope, `A failover incident involves ${node.address}.`, node.id);
        }
        raise('incident', scope, `An open incident involves ${node.address}.`, node.id);
      }
    }
    const primary = nodes.get(shardId);
    if (primary && members.some((node) => node.role === 'replica' && !node.collected)) {
      const replication = facts.replication[shardId];
      if (!replication) {
        raise('unknown', scope, `Could not read INFO replication on ${primary.address}.`, shardId);
      } else if (!replication.replicasInSync) {
        raise(
          'replication_divergence',
          scope,
          `A replica of ${primary.address} is not online and in sync.`,
          shardId,
        );
      }
    }
    const unwatched = members.filter((node) => !node.collected);
    if (unwatched.length > 0) {
      raise(
        'coverage',
        scope,
        `The monitor does not connect to ${unwatched.map((node) => node.address).join(', ')}.`,
        shardId,
      );
    }
  };

  judgeShard('source', facts.sourceShardId);
  for (const shardId of facts.targetShardIds) judgeShard('target', shardId);

  if (settings.excludedShardIds.includes(facts.sourceShardId)) {
    raise('excluded', 'source', 'The placement policy excludes this shard.');
  }
  if (facts.cooldownLeftSlots === 0) {
    raise('cooldown', 'source', 'Every slot of the plan moved too recently.');
  }
  if (facts.quarantinedShardIds.includes(facts.sourceShardId)) {
    raise('quarantined', 'source', 'A move off this shard was rolled back in the last 24 hours.');
  }
  if (!insideMaintenanceWindow(settings.maintenanceWindows, now)) {
    raise('outside_window', 'cluster', 'Outside every maintenance window.');
  }

  return { allowed: blockers.length === 0, blockers, warnings };
}
