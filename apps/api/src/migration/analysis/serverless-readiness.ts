import type { Incompatibility } from '@betterdb/shared';

export const SERVERLESS_RESTRICTED_COMMANDS: readonly string[] = [
  'ACL SETUSER',
  'ACL LOAD',
  'ACL SAVE',
  'ACL DELUSER',
  'BGREWRITEAOF',
  'BGSAVE',
  'CLUSTER ADDSLOTS',
  'CLUSTER ADDSLOTSRANGE',
  'CLUSTER BUMPEPOCH',
  'CLUSTER DELSLOTS',
  'CLUSTER DELSLOTSRANGE',
  'CLUSTER FAILOVER',
  'CLUSTER FLUSHSLOTS',
  'CLUSTER FORGET',
  'CLUSTER LINKS',
  'CLUSTER MEET',
  'CLUSTER SETSLOT',
  'CONFIG',
  'DEBUG',
  'MIGRATE',
  'PSYNC',
  'REPLICAOF',
  'SAVE',
  'SLAVEOF',
  'SHUTDOWN',
  'SYNC',
  'ACL LOG',
  'CLIENT CACHING',
  'CLIENT GETREDIR',
  'CLIENT ID',
  'CLIENT INFO',
  'CLIENT KILL',
  'CLIENT LIST',
  'CLIENT NO-EVICT',
  'CLIENT PAUSE',
  'CLIENT TRACKING',
  'CLIENT TRACKINGINFO',
  'CLIENT UNBLOCK',
  'CLIENT UNPAUSE',
  'CLUSTER COUNT-FAILURE-REPORTS',
  'COMMANDLOG',
  'FCALL',
  'FCALL_RO',
  'FUNCTION',
  'KEYS',
  'LASTSAVE',
  'LATENCY',
  'MEMORY',
  'MONITOR',
  'MOVE',
  'OBJECT',
  'PFDEBUG',
  'PFSELFTEST',
  'PSUBSCRIBE',
  'PUBSUB NUMPAT',
  'PUNSUBSCRIBE',
  'SCRIPT KILL',
  'SLOWLOG',
  'SWAPDB',
  'WAIT',
];

const RESTRICTED = new Set(SERVERLESS_RESTRICTED_COMMANDS);

const SERVERLESS_HOST_PATTERN = /\.serverless\.[a-z0-9-]+\.cache\.amazonaws\.com$/i;

const CATEGORY = 'serverless_readiness';
const GIB = 1024 * 1024 * 1024;
const MAX_KEY_NAME_BYTES = 4096;
const MAX_MASTER_MEMORY_BYTES = 32 * GIB;
const MAX_CACHE_MEMORY_BYTES = 5000 * GIB;
const MAX_MASTERS = 166;
const TOTAL_SLOTS = 16384;

const SUPPORTED_VERSIONS: Record<'valkey' | 'redis', { label: string; min: [number, number]; max: [number, number] }> = {
  redis: { label: 'Redis OSS 4.0–7.2', min: [4, 0], max: [7, 2] },
  valkey: { label: 'Valkey 7.2–8.1', min: [7, 2], max: [8, 1] },
};

export interface ServerlessClusterMaster {
  slots: number[][];
  migratingSlots: number;
  importingSlots: number;
}

export interface ServerlessCommandEntry {
  command: string[];
  clientName?: string;
}

export interface ServerlessReadinessFacts {
  dbType: 'valkey' | 'redis';
  version: string;
  isCluster: boolean;
  clusterMasterCount: number;
  masterUsedMemory: number[];
  sampledKeyBytes: number[];
  databasesBeyondZero: string[];
  functionPresence: 'present' | 'absent' | 'unknown';
  missingReplicationCommands: string[] | null;
  clusterMasters: ServerlessClusterMaster[] | null;
  cachedScripts: number | null;
  pubsub: { channels: number; patterns: number; shardChannels: number } | null;
  commandEntries: ServerlessCommandEntry[];
}

const INTERNAL_CLIENT_NAMES = new Set([
  'betterdb-monitor',
  'betterdb-monitor-keyscan',
  'betterdb-monitor-discovery',
  'betterdb-monitor-sentinel-discovery',
  'betterdb-monitor-sessionexplorer',
  'betterdb-cli',
  'betterdb-agent',
  'betterdb-agent-cli',
  'betterdb-migration-analysis',
  'betterdb-migration-discovery',
  'betterdb-migration-source',
  'betterdb-migration-target',
  'betterdb-validation-source',
  'betterdb-validation-source-cluster',
  'betterdb-validation-target',
]);
const INTERNAL_NODE_CLIENT_PATTERN = /^betterdb-monitor-node-[0-9a-f]{8}$/i;

function isInternalClient(clientName: string | undefined): boolean {
  if (!clientName) return false;
  return INTERNAL_CLIENT_NAMES.has(clientName.toLowerCase()) || INTERNAL_NODE_CLIENT_PATTERN.test(clientName);
}

export function countSlotOwningMasters(nodes: ReadonlyArray<{ flags: string[]; slots: number[][] }>): number {
  return nodes.filter((node) => {
    return node.flags.includes('master') && node.slots.length > 0;
  }).length;
}

export function isElastiCacheServerlessHost(host: string): boolean {
  return SERVERLESS_HOST_PATTERN.test(host);
}

export function findRestrictedCommands(
  entries: ServerlessCommandEntry[],
): Array<{ command: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (isInternalClient(entry.clientName)) continue;
    const first = String(entry.command[0] ?? '').toUpperCase();
    if (!first) continue;
    const second = String(entry.command[1] ?? '').toUpperCase();
    const twoWord = `${first} ${second}`;
    const match = second && RESTRICTED.has(twoWord) ? twoWord : RESTRICTED.has(first) ? first : null;
    if (!match) continue;
    counts.set(match, (counts.get(match) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count);
}

function parseMajorMinor(version: string): [number, number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10)];
}

function compareMajorMinor(a: [number, number], b: [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

function slotProblems(masters: ServerlessClusterMaster[]): string[] {
  const owners = new Uint16Array(TOTAL_SLOTS);
  for (const master of masters) {
    for (const range of master.slots) {
      const start = Math.max(0, range[0] ?? 0);
      const end = Math.min(TOTAL_SLOTS - 1, range[1] ?? range[0] ?? -1);
      for (let slot = start; slot <= end; slot++) owners[slot]++;
    }
  }
  let gaps = 0;
  let overlaps = 0;
  for (const count of owners) {
    if (count === 0) gaps++;
    if (count > 1) overlaps++;
  }
  const moving = masters.reduce((sum, m) => sum + m.migratingSlots + m.importingSlots, 0);

  const problems: string[] = [];
  if (gaps > 0) problems.push(`${gaps} slot${gaps === 1 ? '' : 's'} unassigned`);
  if (overlaps > 0) problems.push(`${overlaps} slot${overlaps === 1 ? '' : 's'} owned by more than one master`);
  if (moving > 0) problems.push('a slot migration in progress (migrating or importing slots)');
  return problems;
}

export function checkServerlessReadiness(facts: ServerlessReadinessFacts): Incompatibility[] {
  const issues: Incompatibility[] = [];

  const longKeys = facts.sampledKeyBytes.filter(bytes => bytes > MAX_KEY_NAME_BYTES);
  if (longKeys.length > 0) {
    issues.push({
      severity: 'blocking',
      category: CATEGORY,
      title: 'Key names over 4 KiB',
      detail:
        `${longKeys.length} key name${longKeys.length === 1 ? '' : 's'} in the sample exceed${longKeys.length === 1 ? 's' : ''} ` +
        'the 4 KiB ElastiCache Serverless key name limit. AWS migration fails on the initial load and cannot be restarted. ' +
        'Rename these keys before migrating; the full keyspace may hold more than the sample found.',
    });
  }

  if (facts.databasesBeyondZero.length > 0) {
    issues.push({
      severity: 'blocking',
      category: CATEGORY,
      title: 'Keys outside database 0',
      detail:
        `The source holds keys in ${facts.databasesBeyondZero.join(', ')}. ElastiCache Serverless runs in cluster mode and serves db0 only, ` +
        'so these keys cannot be migrated as they are.',
    });
  }

  if (facts.functionPresence === 'present') {
    issues.push({
      severity: 'blocking',
      category: CATEGORY,
      title: 'Function libraries on the source',
      detail:
        'The source holds function libraries. ElastiCache Serverless restricts FUNCTION and FCALL, so every FCALL fails after cutover. ' +
        'Move this logic to EVAL scripts or client code before migrating.',
    });
  } else if (facts.functionPresence === 'unknown') {
    issues.push({
      severity: 'warning',
      category: CATEGORY,
      title: 'Function libraries could not be checked',
      detail:
        'FUNCTION LIST could not be read on every node. ElastiCache Serverless restricts FUNCTION and FCALL, so confirm the source uses no function libraries.',
    });
  }

  const largestMaster = facts.masterUsedMemory.reduce((max, bytes) => Math.max(max, bytes), 0);
  if (largestMaster > MAX_MASTER_MEMORY_BYTES) {
    issues.push({
      severity: 'warning',
      category: CATEGORY,
      awsToolOnly: true,
      title: 'Source master over 32 GB',
      detail:
        `A source master uses ${formatGiB(largestMaster)}. The AWS migration tool accepts at most 32 GB per source node; ` +
        'reshard the source across more masters to use it. BetterDB migration has no per-node limit.',
    });
  }

  const totalMemory = facts.masterUsedMemory.reduce((sum, bytes) => sum + bytes, 0);
  if (totalMemory > MAX_CACHE_MEMORY_BYTES) {
    issues.push({
      severity: 'blocking',
      category: CATEGORY,
      title: 'Dataset over 5,000 GiB',
      detail:
        `The source uses ${formatGiB(totalMemory)} in total. An ElastiCache Serverless cache holds at most 5,000 GiB.`,
    });
  }

  if (facts.isCluster && facts.clusterMasterCount > MAX_MASTERS) {
    issues.push({
      severity: 'warning',
      category: CATEGORY,
      awsToolOnly: true,
      title: 'More than 166 masters',
      detail:
        `The source has ${facts.clusterMasterCount} masters. The AWS migration tool supports at most ${MAX_MASTERS}. ` +
        'BetterDB migration has no master limit.',
    });
  }

  if (!facts.isCluster) {
    issues.push({
      severity: 'warning',
      category: CATEGORY,
      awsToolOnly: true,
      title: 'Standalone source',
      detail:
        'The AWS migration tool accepts cluster-mode sources only. BetterDB migration can still copy a standalone source into ElastiCache Serverless.',
    });
  }

  const range = SUPPORTED_VERSIONS[facts.dbType];
  const parsed = parseMajorMinor(facts.version);
  if (range && parsed && (compareMajorMinor(parsed, range.min) < 0 || compareMajorMinor(parsed, range.max) > 0)) {
    issues.push({
      severity: 'warning',
      category: CATEGORY,
      awsToolOnly: true,
      title: 'Source version not supported by AWS migration',
      detail:
        `The source runs ${facts.dbType === 'valkey' ? 'Valkey' : 'Redis'} ${facts.version}. The AWS migration tool supports ` +
        `${SUPPORTED_VERSIONS.redis.label} and ${SUPPORTED_VERSIONS.valkey.label} sources.`,
    });
  }

  if (facts.missingReplicationCommands && facts.missingReplicationCommands.length > 0) {
    issues.push({
      severity: 'warning',
      category: CATEGORY,
      awsToolOnly: true,
      title: 'Replication commands unavailable',
      detail:
        `${facts.missingReplicationCommands.join(', ')} ${facts.missingReplicationCommands.length === 1 ? 'is' : 'are'} renamed or absent on the source. ` +
        'Online migration into ElastiCache Serverless replicates through PSYNC and REPLCONF.',
    });
  }

  if (facts.isCluster && facts.clusterMasters) {
    const problems = slotProblems(facts.clusterMasters);
    if (problems.length > 0) {
      issues.push({
        severity: 'warning',
        category: CATEGORY,
        awsToolOnly: true,
        title: 'Slot coverage incomplete or changing',
        detail:
          `The source cluster has ${problems.join(', ')}. The AWS migration tool needs every slot owned by exactly one master and no resharding in progress.`,
      });
    }
  }

  if (facts.cachedScripts !== null && facts.cachedScripts > 0) {
    issues.push({
      severity: 'warning',
      category: CATEGORY,
      title: 'Scripts in the script cache',
      detail:
        `The source has ${facts.cachedScripts} cached script${facts.cachedScripts === 1 ? '' : 's'}. The script cache is not migrated; ` +
        'reload scripts through the new endpoint or clients will get NOSCRIPT after cutover.',
    });
  }

  if (facts.pubsub) {
    const { channels, patterns, shardChannels } = facts.pubsub;
    if (channels + shardChannels > 0) {
      issues.push({
        severity: 'warning',
        category: CATEGORY,
        title: 'Pub/sub subscribers present',
        detail:
          `The source has ${channels} subscribed channel${channels === 1 ? '' : 's'} ` +
          `and ${shardChannels} sharded channel${shardChannels === 1 ? '' : 's'}. Subscribers are disconnected at cutover and must resubscribe.`,
      });
    }
    if (patterns > 0) {
      issues.push({
        severity: 'warning',
        category: CATEGORY,
        title: 'Pattern subscribers present',
        detail:
          `The source has ${patterns} pattern subscription${patterns === 1 ? '' : 's'}. ElastiCache Serverless restricts PSUBSCRIBE and PUNSUBSCRIBE, ` +
          'so these clients cannot subscribe again after cutover. Switch them to channel or sharded subscriptions before migrating.',
      });
    }
  }

  const restricted = findRestrictedCommands(facts.commandEntries);
  if (restricted.length > 0) {
    issues.push({
      severity: 'warning',
      category: CATEGORY,
      title: 'Commands restricted on ElastiCache Serverless',
      detail:
        `The command log shows ${restricted.map(r => `${r.command} (${r.count})`).join(', ')}. ElastiCache Serverless rejects these ` +
        'commands from the moment the application is redirected to it.',
    });
  }

  return issues;
}
