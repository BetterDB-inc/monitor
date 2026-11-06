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
   * Per seed id, for the address it had: whether the last sync called it an
   * alias. A seed is only treated as an alias once two syncs in a row say so,
   * so one stale CLUSTER NODES reply (after a pod IP change) cannot register
   * its own node as a duplicate child; it is one node again as soon as a sync
   * says so.
   */
  private readonly lastAliasVerdict = new Map<string, { address: string; alias: boolean }>();

  constructor(private readonly discovery: ClusterDiscoveryService) {}

  handles(caps: DatabaseCapabilities): boolean {
    return caps.clusterEnabled === true;
  }

  async discover(seed: DatabaseConnectionConfig, timeoutMs: number): Promise<TopologyDiscovery | null> {
    const [nodes, seedAddresses] = await Promise.all([
      this.discovery.discoverNodesIsolated(seed.id, timeoutMs),
      this.resolveHost(seed.host),
    ]);
    if (nodes.length === 0) return null;
    // Without the seed's addresses `myself` cannot be told apart from the seed;
    // leave membership as it is for this sync rather than guess.
    if (seedAddresses.length === 0) return null;
    const address = addressKey(seed.host, seed.port);
    const prior = this.lastAliasVerdict.get(seed.id);
    const verdict = seedIsAlias(seed, seedAddresses, nodes);
    this.lastAliasVerdict.set(seed.id, { address, alias: verdict });
    const confirmed = verdict && prior?.address === address && prior.alias;
    const desired = desiredFromDiscovery(seed, nodes, { seedIsAlias: confirmed });
    // A first alias verdict is not trusted yet. Where it decides whether
    // `myself` is a child, leave membership as it is for this sync rather than
    // add that node or retire it.
    if (verdict && !confirmed && desiredFromDiscovery(seed, nodes, { seedIsAlias: true }).length !== desired.length) {
      return null;
    }
    return { nodes: desired, unknownGroups: [] };
  }

  forget(seedId: string): void {
    this.lastAliasVerdict.delete(seedId);
  }
}
