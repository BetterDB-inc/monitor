import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import type { DatabaseCapabilities } from '../common/interfaces/database-port.interface';
import { ClusterDiscoveryService } from '../cluster/cluster-discovery.service';
import { addressKey, desiredFromDiscovery, seedIsAlias } from './membership-diff';
import type { TopologyDiscovery, TopologySource } from './topology-source';

const RESOLVE_TIMEOUT_MS = 2_000;
/** Syncs of `myself` remembered for a seed that matches no node. */
const RECENT_ANSWERS = 10;
/**
 * Syncs in a row one node must answer before a change of `myself` is a move,
 * and the number of different nodes answering that proves a VIP.
 */
const SETTLED_ANSWERS = 3;

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
   * `answered` holds the recent `myself` ids, oldest first, since the node
   * behind a seed that matches no node last settled.
   */
  private readonly aliasState = new Map<
    string,
    { address: string; alias: boolean; last: boolean; answered: readonly string[] }
  >();

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
    const known = this.aliasState.get(seed.id);
    const prior = known?.address === address ? known : undefined;
    // With nothing remembered (a new seed, or a restarted monitor), start from
    // what is registered: `myself` already a member means the seed was an alias.
    const myself = nodes.find((n) => n.flags.includes('myself'));
    const initial = myself !== undefined && registeredNodeIds?.has(myself.id) === true;
    let answered = [...(prior?.answered ?? []), ...(myself ? [myself.id] : [])].slice(-RECENT_ANSWERS);
    const matched = seedIsAlias(seed, seedAddresses, nodes);
    let verdict: boolean;
    let alias: boolean;
    let undecided = false;
    if (matched === null) {
      // No node announces the seed's address. A VIP lands discovery on an
      // arbitrary node each sync, so a node that answered before answers again
      // after another one did, or several different nodes answer. One node
      // behind NAT or a port mapping answers as itself, and after a failover or
      // replacement as the new node, for good.
      const current = answered[answered.length - 1];
      const previous = answered[answered.length - 2];
      const settled = (count: number) =>
        answered.length >= count && answered.slice(-count).every((id) => id === current);
      const returned = previous !== undefined && current !== previous && answered.slice(0, -2).includes(current);
      const wasAlias = prior ? prior.alias : initial;
      // A failback (A, B, A) looks like a VIP before A has answered a few syncs
      // in a row. Leaving that alias in place registers A as its own child, so
      // once it has settled it is the seed's node, and the nodes before it no
      // longer count. Any other alias (three different nodes, a restart) may be
      // a VIP that landed on one node a few times in a row, so it holds until
      // the same node has answered RECENT_ANSWERS syncs in a row.
      const changes = answered.filter((id, i) => i > 0 && id !== answered[i - 1]).length;
      const failedBack = changes === 2 && answered[0] === current;
      if (settled(SETTLED_ANSWERS) && (!wasAlias || failedBack || settled(RECENT_ANSWERS))) {
        alias = false;
        verdict = false;
        undecided = false;
        answered = [current];
      } else {
        alias = returned || new Set(answered).size >= SETTLED_ANSWERS || wasAlias;
        verdict = alias;
        // A change of `myself` not yet seen as either is left alone until the new
        // node has answered a few syncs in a row, at most until a third node or an
        // earlier one answers.
        undecided = !alias && new Set(answered.slice(-SETTLED_ANSWERS)).size > 1;
      }
    } else {
      verdict = matched;
      alias = prior ? (verdict === prior.last ? verdict : prior.alias) : initial;
    }
    this.aliasState.set(seed.id, { address, alias, last: verdict, answered });
    if (undecided) return null;
    const desired = desiredFromDiscovery(seed, nodes, { seedIsAlias: alias });
    // A first verdict that disagrees with the starting point is not trusted
    // yet. Where it decides whether `myself` is a child, leave membership as it
    // is for this sync rather than add that node or retire it.
    if (!prior && verdict !== alias && desiredFromDiscovery(seed, nodes, { seedIsAlias: verdict }).length !== desired.length) {
      return null;
    }
    return { nodes: desired, unknownGroups: [] };
  }

  forget(seedId: string): void {
    this.aliasState.delete(seedId);
  }
}
