import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import type { DatabaseCapabilities } from '../common/interfaces/database-port.interface';
import { ClusterDiscoveryService } from '../cluster/cluster-discovery.service';
import { addressKey, desiredFromDiscovery, seedIsAlias } from './membership-diff';
import type { TopologyDiscovery, TopologySource } from './topology-source';

const RESOLVE_TIMEOUT_MS = 2_000;

/**
 * Addresses a seed host resolves to; an IP literal resolves to itself. A failed
 * or slow lookup resolves to none, so it can never hold up discovery.
 */
export async function resolveHostAddresses(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), RESOLVE_TIMEOUT_MS);
    timer.unref();
  });
  const resolved = lookup(host, { all: true })
    .then((records) => [...new Set(records.map((record) => record.address))])
    .catch(() => []);
  try {
    return await Promise.race([resolved, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class ClusterTopologySource implements TopologySource {
  readonly kind = 'cluster' as const;
  readonly envFlag = 'CLUSTER_AUTO_REGISTER_NODES';

  /** Overridable in tests. */
  resolveHost: (host: string) => Promise<string[]> = resolveHostAddresses;

  /**
   * Per seed id, for the address it had: whether it is treated as an alias, and
   * the last sync's verdict. The treatment changes only when two syncs in a row
   * disagree with it, so one stale CLUSTER NODES reply (after a pod IP change)
   * cannot register a single node's seed as its own child, and a Service whose
   * DNS answer shrinks to one pod for a sync (a rollout) does not retire `myself`.
   */
  private readonly aliasState = new Map<string, { address: string; alias: boolean; last: boolean }>();

  constructor(private readonly discovery: ClusterDiscoveryService) {}

  handles(caps: DatabaseCapabilities): boolean {
    return caps.clusterEnabled === true;
  }

  async discover(
    seed: DatabaseConnectionConfig,
    timeoutMs: number,
    registeredNodeIds?: ReadonlySet<string>,
  ): Promise<TopologyDiscovery | null> {
    const [nodes, seedAddresses] = await Promise.all([
      this.discovery.discoverNodesIsolated(seed.id, timeoutMs),
      this.resolveHost(seed.host),
    ]);
    if (nodes.length === 0) return null;
    // Without the seed's addresses `myself` cannot be told apart from the seed;
    // leave membership as it is for this sync rather than guess.
    if (seedAddresses.length === 0) return null;
    const address = addressKey(seed.host, seed.port);
    const verdict = seedIsAlias(seed, seedAddresses, nodes);
    const known = this.aliasState.get(seed.id);
    const prior = known?.address === address ? known : undefined;
    // With nothing remembered (a new seed, or a restarted monitor), start from
    // what is registered: `myself` already a member means the seed was an alias.
    const myself = nodes.find((n) => n.flags.includes('myself'));
    const initial = myself !== undefined && registeredNodeIds?.has(myself.id) === true;
    const alias = prior ? (verdict === prior.last ? verdict : prior.alias) : initial;
    this.aliasState.set(seed.id, { address, alias, last: verdict });
    const desired = desiredFromDiscovery(seed, nodes, { seedIsAlias: alias });
    // A first verdict that disagrees with the starting point is not trusted
    // yet. Where it decides whether `myself` is a child, leave membership as it
    // is for this sync rather than add that node or retire it.
    if (!prior && verdict !== initial && desiredFromDiscovery(seed, nodes, { seedIsAlias: verdict }).length !== desired.length) {
      return null;
    }
    return { nodes: desired, unknownGroups: [] };
  }

  forget(seedId: string): void {
    this.aliasState.delete(seedId);
  }
}
