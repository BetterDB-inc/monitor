import {
  HOT_KEY_SLOTS,
  type HashTagAdvice,
  type HashTagRead,
  type HotKeyRead,
  type HotKeyReader,
  type PlacementPrimaryFacts,
  type PlacementSupportFacts,
  type RebalanceShard,
  type ShardLoadSample,
  type ShardLoadTracker,
  hashTagsOfNames,
  hashTagsUnavailable,
  hotKeysUnavailable,
  isManagedProviderBuild,
  keyCountOutliers,
  managedPlacementProvider,
  migrateSlotsListed,
  readSlotNames,
  sampleHotKeys,
  shardServerFromInfo,
} from './product';

export interface PrimaryReply {
  address: string;
  info: Record<string, Record<string, string> | undefined> | null;
  commandInfo: unknown;
}

export interface InstallFacts {
  host: string;
  clusterEnabled: boolean;
  perNodeConnections: boolean;
  dialsDataNodes: boolean;
  slotStatsTopN: number;
  slotStatsCommand: boolean;
  primaries: readonly PrimaryReply[];
  rebalanceRefusal: string | null;
  env: Record<string, string | undefined>;
  signIn: boolean;
}

export function rebalanceShards(
  sample: ShardLoadSample,
  hot: ReadonlySet<string>,
): RebalanceShard[] {
  return sample.shards.map((shard) => ({
    shardId: shard.nodeId,
    nodeAddr: shard.address,
    cpuUsecPerSecond: shard.cpuUsecPerSecond,
    slotCount: shard.slotCount,
    state: 'healthy',
    hot: hot.has(shard.nodeId),
  }));
}

function primaryFacts(reply: PrimaryReply): PlacementPrimaryFacts & {
  serverInfo?: Record<string, string | undefined>;
} {
  return {
    address: reply.address,
    server: (reply.info && shardServerFromInfo(reply.info)) ?? null,
    migrateSlotsCommand: migrateSlotsListed(reply.commandInfo),
    serverInfo: reply.info?.server,
  };
}

export function supportFacts(install: InstallFacts): PlacementSupportFacts {
  const primaries =
    install.clusterEnabled && install.dialsDataNodes ? install.primaries.map(primaryFacts) : null;
  const managedBuild = primaries?.find((primary) => isManagedProviderBuild(primary.serverInfo));
  return {
    clusterEnabled: install.clusterEnabled,
    managedProvider: managedPlacementProvider(install.host, managedBuild?.serverInfo),
    clusterWideView: !install.perNodeConnections,
    slotStats: install.slotStatsTopN > 0 && install.slotStatsCommand,
    dialsDataNodes: install.dialsDataNodes,
    primaries,
    aclDenied: install.rebalanceRefusal !== null && /\bNOPERM\b/i.test(install.rebalanceRefusal),
    slotMigrationFlag: String(install.env.BETTERDB_SLOT_MIGRATION) === 'true',
    memoryStorage: String(install.env.STORAGE_TYPE ?? 'memory') === 'memory',
    signIn: install.signIn,
  };
}

export interface HotShardRead {
  keys: HotKeyRead;
  hashTags: HashTagRead;
}

export async function readHotShardKeys(
  client: HotKeyReader,
  topSlots: readonly number[],
): Promise<HotShardRead> {
  const slots = topSlots.slice(0, HOT_KEY_SLOTS);
  const read = await readSlotNames(client, slots);
  if (read.note !== undefined) {
    return { keys: hotKeysUnavailable(read.note), hashTags: hashTagsUnavailable(read.note) };
  }
  return {
    keys: await sampleHotKeys(client, slots, read.names),
    hashTags: hashTagsOfNames(read.names),
  };
}

export function hotShardAdvice(
  tracker: ShardLoadTracker,
  shardId: string,
  read: HotShardRead,
): HashTagAdvice {
  const median = tracker.medianKeyCount();
  return {
    ...read.hashTags,
    keyCountOutliers: median === null ? [] : keyCountOutliers(tracker.slotsOf(shardId), median),
    medianKeyCount: median ?? 0,
  };
}
