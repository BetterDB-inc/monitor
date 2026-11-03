import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import type { DatabaseCapabilities } from '../common/interfaces/database-port.interface';
import { ClusterDiscoveryService } from '../cluster/cluster-discovery.service';
import { desiredFromDiscovery } from './membership-diff';
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
    return {
      nodes: desiredFromDiscovery(seed, nodes, { seedIsAlias: seedAddresses.length > 1 }),
      unknownGroups: [],
    };
  }
}
