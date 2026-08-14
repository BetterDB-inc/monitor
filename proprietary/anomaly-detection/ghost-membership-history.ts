import { ClusterNode } from '@app/common/types/metrics.types';
import { canonicalEndpoint } from './ghost-membership-detector';

/**
 * Stateful Layer 2 of ghost-membership detection: the temporal case the snapshot
 * layer explicitly defers, catching a node that **reintroduces itself after a
 * `CLUSTER FORGET`** (valkey-io/valkey#2788).
 *
 * Since 8.1, `CLUSTER FORGET` only blacklists a node-id for roughly
 * `cluster-node-timeout` (~60s). Any peer that was not also given the FORGET
 * keeps gossiping the removed node, so once the ban lapses the handshake path
 * re-adds it. The operator believes they scaled the cluster down; the node
 * quietly comes back, often with a fresh `configEpoch`. Upstream PR #4090 only
 * blocks the rejoin *during* the blacklist window and explicitly leaves the
 * delayed reconnect unsolved, so the hazard outlives the fix.
 *
 * No single `CLUSTER NODES` snapshot shows this — the returned node just looks
 * like a member. It is only visible as a transition across polls:
 *
 *     present  ->  fully absent from the membership set  ->  present again
 *
 * The middle state is what separates a FORGET from ordinary churn. A node that
 * merely crashed or flapped stays in every peer's table flagged `fail`/`noaddr`,
 * so it never leaves the membership set and never trips this layer. Only an
 * explicit removal takes an id out of the table altogether.
 *
 * One instance holds one connection's history. The service owns the map of them
 * and must drop the instance in `onConnectionRemoved`.
 */

/** A node-id that left the membership set and later came back on its own. */
export interface ForgetRejoin {
  /** The resurrected node-id. */
  nodeId: string;
  /** Canonical `ip:port` it came back on. */
  endpoint: string;
  /** Flags on the returning line, for message context (e.g. still handshaking). */
  flags: string[];
  /** Timestamp of the first poll that no longer listed the id. */
  departedAt: number;
  /** Timestamp of the poll that saw it return. */
  returnedAt: number;
  /** How many consecutive polls the id was absent from the membership set. */
  absentPolls: number;
}

interface DepartedEntry {
  departedAt: number;
  absentPolls: number;
}

/**
 * Consecutive polls an id must be absent from the membership set before its
 * return can count as a self-reintroduction. Two rather than one so a single
 * truncated or mid-gossip `CLUSTER NODES` reply cannot manufacture a departure.
 */
const MIN_ABSENT_POLLS = 2;

/**
 * Wall-clock absence required on top of the poll count, sized to the `CLUSTER
 * FORGET` blacklist window (~`cluster-node-timeout`, 60s by default).
 *
 * The poll count alone is not a meaningful gate: the anomaly loop polls once a
 * second by default, so two polls is two seconds — far inside the window a
 * forgotten node must sit out before it can rejoin at all. Anything that returns
 * faster than the blacklist is definitionally NOT a post-FORGET rejoin; it is
 * ordinary churn, such as the polled node re-learning its peers by gossip after
 * a local `CLUSTER RESET`. Alerting on that would tell the operator to FORGET a
 * node nobody removed.
 */
const MIN_ABSENT_MS = 60_000;

/**
 * How long a departed id is remembered. Past this, the removal is treated as
 * settled: a node that reappears later is a fresh join, not a rejoin, and the
 * entry is dropped so the map cannot grow without bound.
 */
const DEPARTED_RETENTION_MS = 6 * 60 * 60 * 1000;

/**
 * Hard ceiling on remembered departed ids per connection, as a leak guard for a
 * pathological topology. Real clusters are orders of magnitude below this; when
 * it is hit the oldest departures are dropped first.
 */
const MAX_DEPARTED_ENTRIES = 512;

/** Flags marking a line as a dead-but-remembered identity rather than a live member. */
const NON_LIVE_FLAGS = ['fail', 'fail?', 'noaddr'];

function isLive(node: ClusterNode): boolean {
  return !NON_LIVE_FLAGS.some((flag) => {
    return node.flags.includes(flag);
  });
}

export class GhostMembershipHistory {
  /** Node-ids currently present in the membership set. */
  private readonly present = new Set<string>();

  /** Node-ids that have left the membership set and not yet returned. */
  private readonly departed = new Map<string, DepartedEntry>();

  /**
   * Folds one `CLUSTER NODES` observation into the history and returns any
   * self-reintroductions it revealed.
   *
   * Only call this with a successfully fetched node list. A failed fetch is an
   * observation gap, not a mass departure — skipping the call leaves the history
   * intact, whereas passing an empty list would strand every id as departed.
   */
  observe(nodes: ClusterNode[], timestamp: number): ForgetRejoin[] {
    const seenThisPoll = new Set<string>();
    const findings: ForgetRejoin[] = [];

    for (const node of nodes) {
      seenThisPoll.add(node.id);
    }

    // Ids still missing this poll age their absence. Done before the newly
    // departed are recorded below, so an id cannot be aged in the same poll it
    // first goes missing.
    for (const [nodeId, entry] of this.departed) {
      if (seenThisPoll.has(nodeId)) {
        continue;
      }
      entry.absentPolls += 1;
    }

    for (const node of nodes) {
      const entry = this.departed.get(node.id);
      if (entry === undefined) {
        this.present.add(node.id);
        continue;
      }

      // Back in the table, but still only as a dead-twin line: the id has not
      // actually rejoined yet. Hold the departure open without aging it.
      if (!isLive(node)) {
        continue;
      }

      this.departed.delete(node.id);
      this.present.add(node.id);

      // A return inside the minimum window is churn, not a FORGET — the id never
      // convincingly left, or it came back faster than the blacklist allows.
      if (entry.absentPolls < MIN_ABSENT_POLLS) {
        continue;
      }
      if (timestamp - entry.departedAt < MIN_ABSENT_MS) {
        continue;
      }

      findings.push({
        nodeId: node.id,
        endpoint: canonicalEndpoint(node.address),
        flags: node.flags,
        departedAt: entry.departedAt,
        returnedAt: timestamp,
        absentPolls: entry.absentPolls,
      });
    }

    for (const nodeId of this.present) {
      if (seenThisPoll.has(nodeId)) {
        continue;
      }
      this.present.delete(nodeId);
      this.departed.set(nodeId, { departedAt: timestamp, absentPolls: 1 });
    }

    this.evictStaleDepartures(timestamp);

    return findings;
  }

  /** Test/diagnostic accessor: how many departed ids are currently remembered. */
  departedCount(): number {
    return this.departed.size;
  }

  /**
   * Drops departures that are older than the retention window, then enforces the
   * hard entry ceiling oldest-first. A node whose removal has settled is no
   * longer interesting, and neither is an unbounded map.
   */
  private evictStaleDepartures(timestamp: number): void {
    for (const [nodeId, entry] of this.departed) {
      if (timestamp - entry.departedAt <= DEPARTED_RETENTION_MS) {
        continue;
      }
      this.departed.delete(nodeId);
    }

    if (this.departed.size <= MAX_DEPARTED_ENTRIES) {
      return;
    }

    const oldestFirst = [...this.departed.entries()].sort((a, b) => {
      return a[1].departedAt - b[1].departedAt;
    });
    const excess = this.departed.size - MAX_DEPARTED_ENTRIES;
    for (const [nodeId] of oldestFirst.slice(0, excess)) {
      this.departed.delete(nodeId);
    }
  }
}
