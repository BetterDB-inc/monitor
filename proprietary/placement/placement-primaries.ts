import type { DiscoveredNode } from '@app/cluster/cluster-discovery.service';
import { mapWithLimit } from '../anomaly-detection/bounded-map';
import { shardServerFromInfo } from '../anomaly-detection/rebalance-planner';
import { migrateSlotsListed, type PlacementPrimaryRead } from './placement-support';

const PLACEMENT_READ_CONCURRENCY = 4;

export type PrimaryInfo = Record<string, Record<string, string> | undefined>;

export interface PlacementPrimaryReader {
  info(nodeId: string): Promise<PrimaryInfo | undefined>;
  migrateSlotsInfo(nodeId: string): Promise<unknown>;
}

export function placementPrimaryFacts(
  address: string,
  info: PrimaryInfo | undefined,
  migrateSlotsCommand: boolean | null,
): PlacementPrimaryRead {
  return {
    address,
    server: (info && shardServerFromInfo(info)) ?? null,
    migrateSlotsCommand,
    serverInfo: info?.server,
  };
}

export function readPlacementPrimaryFacts(
  nodes: readonly DiscoveredNode[],
  reader: PlacementPrimaryReader,
): Promise<PlacementPrimaryRead[]> {
  const primaries = nodes.filter((node) => node.role === 'master' && node.slots.length > 0);
  return mapWithLimit(primaries, PLACEMENT_READ_CONCURRENCY, async (node) => {
    const [info, migrateSlotsCommand] = await Promise.all([
      reader.info(node.id),
      reader.migrateSlotsInfo(node.id).then(migrateSlotsListed, () => null),
    ]);
    return placementPrimaryFacts(node.address, info, migrateSlotsCommand);
  });
}
