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
   * Seeds (by id and address) seen as an alias at least once. A Service whose
   * DNS answer shrinks to one node for a while (a rollout) would otherwise flip
   * to a single-node seed and retire `myself`, then restore it on the next sync.
   */
  private readonly aliasSeeds = new Set<string>();

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
    const aliasKey = `${seed.id}|${addressKey(seed.host, seed.port)}`;
    if (seedIsAlias(seed, seedAddresses, nodes)) this.aliasSeeds.add(aliasKey);
    return {
      nodes: desiredFromDiscovery(seed, nodes, { seedIsAlias: this.aliasSeeds.has(aliasKey) }),
      unknownGroups: [],
    };
  }
}
