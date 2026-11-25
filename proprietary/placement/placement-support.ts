import type {
  PlacementMode,
  PlacementModeSupport,
  PlacementSupport,
  PlacementSupportIssue,
  PlacementSupportReason,
} from '@betterdb/shared';
import {
  isManagedProviderBuild,
  matchByHost,
  readProviderOverride,
  type Provider,
} from '@app/monitor/provider-detector';
import { atomicMigration, type ShardServer } from '../anomaly-detection/rebalance-planner';

export interface PlacementPrimaryFacts {
  address: string;
  server: ShardServer | null;
  migrateSlotsCommand: boolean | null;
}

export interface PlacementSupportFacts {
  clusterEnabled: boolean;
  managedProvider: string | null;
  clusterWideView: boolean;
  slotStats: boolean;
  dialsDataNodes: boolean;
  primaries: PlacementPrimaryFacts[] | null;
  aclDenied: boolean;
  slotMigrationFlag: boolean;
  memoryStorage: boolean;
  signIn: boolean;
}

const READ_ONLY: readonly PlacementSupportReason[] = [
  'not_cluster',
  'per_node_connections',
  'slot_stats_off',
  'not_dialed',
];

const RUN_BLOCKERS: readonly PlacementSupportReason[] = [
  ...READ_ONLY,
  'provider_managed',
  'server_version',
  'copy_only',
  'command_unavailable',
  'acl',
  'flag_off',
  'memory_storage',
];

const BLOCKERS: Record<PlacementMode, readonly PlacementSupportReason[]> = {
  observe: [],
  recommend: READ_ONLY,
  approve: RUN_BLOCKERS,
  auto: [...RUN_BLOCKERS, 'no_sign_in'],
};

const PROVIDER_NAMES: Partial<Record<Provider, string>> = {
  'aws-elasticache': 'AWS ElastiCache',
  'gcp-memorystore': 'Google Memorystore',
  'redis-cloud': 'Redis Cloud',
  upstash: 'Upstash',
};

const PLACEMENT_HOST_SUFFIXES: ReadonlyArray<[string, string]> = [
  ['.redis.cache.windows.net', 'Azure Cache for Redis'],
  ['.aivencloud.com', 'Aiven'],
];

export function managedPlacementProvider(
  host: string | undefined,
  server: Record<string, string | undefined> | undefined,
): string | null {
  const override = readProviderOverride();
  const overrideName = override ? PROVIDER_NAMES[override] : undefined;
  if (overrideName) return overrideName;
  const fromHost = matchByHost(host);
  const hostName = fromHost ? PROVIDER_NAMES[fromHost] : undefined;
  if (hostName) return hostName;
  const lower = host?.toLowerCase() ?? '';
  const extra = PLACEMENT_HOST_SUFFIXES.find(([suffix]) => lower.endsWith(suffix));
  if (extra) return extra[1];
  return isManagedProviderBuild(server) ? 'Redis Cloud' : null;
}

const listed = (addresses: readonly string[]) => addresses.join(', ');

function serverIssue(primaries: readonly PlacementPrimaryFacts[] | null): PlacementSupportIssue | null {
  if (primaries === null || primaries.length === 0) {
    return { reason: 'server_version', detail: 'The server versions of the primaries could not be read.' };
  }
  const unread = primaries.filter((primary) => primary.server === null);
  if (unread.length > 0) {
    return {
      reason: 'server_version',
      detail: `The server version could not be read on ${listed(unread.map((p) => p.address))}.`,
    };
  }
  const servers = primaries.map((primary) => primary.server as ShardServer);
  const atomic = servers.map((server) => atomicMigration(server));
  const allValkey = servers.every((server) => server.dbType === 'valkey');
  const allRedis = servers.every((server) => server.dbType === 'redis');
  if (allRedis && atomic.every((able) => able === true)) {
    return {
      reason: 'copy_only',
      detail: 'Redis 8.4+ slot migration is shown as commands to copy; BetterDB does not run it.',
    };
  }
  const behind = primaries.filter(
    (primary, index) => !allValkey || primary.server?.dbType !== 'valkey' || atomic[index] !== true,
  );
  if (behind.length > 0) {
    return {
      reason: 'server_version',
      detail: `Slot moves need Valkey 9.0 or later on every primary: ${listed(
        behind.map((p) => `${p.address} runs ${p.server?.dbType} ${p.server?.version}`),
      )}.`,
    };
  }
  return null;
}

function commandIssue(primaries: readonly PlacementPrimaryFacts[] | null): PlacementSupportIssue | null {
  if (primaries === null) return null;
  const missing = primaries.filter((primary) => primary.migrateSlotsCommand !== true);
  if (missing.length === 0) return null;
  return {
    reason: 'command_unavailable',
    detail: `CLUSTER MIGRATESLOTS is renamed, disabled or could not be checked on ${listed(
      missing.map((p) => p.address),
    )}.`,
  };
}

function issuesOf(facts: PlacementSupportFacts): PlacementSupportIssue[] {
  if (!facts.clusterEnabled) {
    return [{ reason: 'not_cluster', detail: 'Slot placement needs cluster mode.' }];
  }
  const issues: PlacementSupportIssue[] = [];
  if (facts.managedProvider) {
    issues.push({
      reason: 'provider_managed',
      provider: facts.managedProvider,
      detail: `Managed by ${facts.managedProvider}: slot moves go through the provider's resharding.`,
    });
  }
  if (!facts.clusterWideView) {
    issues.push({
      reason: 'per_node_connections',
      detail: 'The cluster nodes are registered one by one, so no connection sees the whole cluster.',
    });
  }
  if (!facts.slotStats) {
    issues.push({
      reason: 'slot_stats_off',
      detail: 'Per-slot load is not collected (CLUSTER SLOT-STATS is off or unavailable).',
    });
  }
  if (!facts.dialsDataNodes) {
    issues.push({
      reason: 'not_dialed',
      detail: 'The monitor reaches this cluster through an agent or OTLP and cannot open node connections.',
    });
  } else {
    const server = serverIssue(facts.primaries) ?? commandIssue(facts.primaries);
    if (server) issues.push(server);
  }
  if (facts.aclDenied) {
    issues.push({
      reason: 'acl',
      detail: "The monitor's user was refused a slot migration command (NOPERM).",
    });
  }
  if (!facts.slotMigrationFlag) {
    issues.push({
      reason: 'flag_off',
      detail: 'Running slot moves is off on this install (BETTERDB_SLOT_MIGRATION).',
    });
  }
  if (facts.memoryStorage) {
    issues.push({
      reason: 'memory_storage',
      detail: 'Running slot moves needs durable storage (sqlite, turso or postgres).',
    });
  }
  if (!facts.signIn) {
    issues.push({
      reason: 'no_sign_in',
      detail: 'Auto needs a signed-in admin; this install runs without sign-in.',
    });
  }
  return issues;
}

export function judgePlacementSupport(facts: PlacementSupportFacts): PlacementSupport {
  const issues = issuesOf(facts);
  const modeSupport = (mode: PlacementMode): PlacementModeSupport => {
    const blocking = issues.find((issue) => BLOCKERS[mode].includes(issue.reason));
    return { available: !blocking, blockedBy: blocking?.reason ?? null };
  };
  return {
    issues,
    modes: {
      observe: modeSupport('observe'),
      recommend: modeSupport('recommend'),
      approve: modeSupport('approve'),
      auto: modeSupport('auto'),
    },
  };
}
