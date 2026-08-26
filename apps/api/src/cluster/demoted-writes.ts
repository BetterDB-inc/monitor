import { TopologyDiff, TopologySnapshot } from './topology-diff';

/**
 * How long after a demotion the node stays worth watching. Past this the
 * disagreement is no longer attributable to the failover, and keeping the
 * entry would let unrelated discovery skew page as data loss.
 */
export const DEMOTION_WATCH_TTL_MS = 60_000;

/** What one demoted node was observed doing on a single poll. */
export interface DemotedNodeObservation {
  nodeId: string;
  nodeAddress: string;
  /** The node's own view, from its `INFO replication`. Absent if that read failed. */
  selfReportedRole?: 'master' | 'replica';
  opsPerSec: number;
  /** Cumulative write-command calls. Absent when the node has no commandstats. */
  writeCommandCalls?: number;
}

export interface DemotedNodeWatchEntry {
  demotedAt: number;
  /** When the node first disagreed with the cluster; null while it agrees. */
  disagreementSince: number | null;
  consecutiveDisagreements: number;
  writeCallsBaseline?: number;
  alerted: boolean;
}

/** Nodes demoted recently enough that traffic on them still means data loss. */
export type DemotionWatch = Map<string, DemotedNodeWatchEntry>;

export interface DemotedWriteAlert {
  nodeId: string;
  nodeAddress: string;
  demotedForMs: number;
  disagreementMs: number;
  opsPerSec: number;
  /**
   * Write calls counted since the previous poll. Absent when the node exposes
   * no commandstats — the alert then rests on `opsPerSec` alone and says
   * "traffic", not "writes".
   */
  writeCallsDelta?: number;
}

/**
 * Arm the watch for every node this poll's failover demoted.
 *
 * Only master→replica transitions qualify. A promotion is the other half of
 * the same failover and is the healthy outcome; watching it would report the
 * new master's normal write traffic as data loss.
 */
export function recordDemotions(watch: DemotionWatch, diff: TopologyDiff, now: number): void {
  for (const change of diff.changedNodes) {
    if (change.reason !== 'role_change') {
      continue;
    }
    if (change.from !== 'master' || change.to !== 'replica') {
      continue;
    }
    if (watch.has(change.nodeId)) {
      continue;
    }
    watch.set(change.nodeId, {
      demotedAt: now,
      disagreementSince: null,
      consecutiveDisagreements: 0,
      alerted: false,
    });
  }
}

/**
 * Drop entries the watch no longer has a reason to hold: the window expired,
 * the node left the cluster, or it was promoted back — in which case it is a
 * master again and its writes are legitimate.
 */
export function pruneDemotionWatch(
  watch: DemotionWatch,
  topology: TopologySnapshot | null,
  now: number,
  ttlMs: number = DEMOTION_WATCH_TTL_MS,
): void {
  for (const [nodeId, entry] of watch) {
    if (now - entry.demotedAt > ttlMs) {
      watch.delete(nodeId);
      continue;
    }
    if (topology === null) {
      continue;
    }
    const current = topology.get(nodeId);
    if (current === undefined || current.role === 'master') {
      watch.delete(nodeId);
    }
  }
}

/**
 * Decide which watched nodes are in the data-loss window.
 *
 * The signal is disagreement: the cluster has demoted the node, the node still
 * answers `role:master`, so it accepts writes for slots it no longer owns and
 * those writes vanish when the client's slot cache refreshes. Phase 2 — the
 * node knows it is a replica and answers `-MOVED` — fails loudly and is
 * deliberately not reported here.
 *
 * Two disagreeing observations are required, which is what makes the write
 * delta computable — the first only establishes the baseline. The count alone
 * is not the persistence guarantee, because `/metrics` scrapes drive the same
 * update path as the poller and two of them can land milliseconds apart; the
 * disagreement must also have lasted `minDisagreementMs`, the caller's poll
 * interval.
 *
 * Mutates `watch` — the counters and baselines it advances are the state that
 * makes the persistence requirement work across polls.
 */
export function evaluateDemotedWrites(
  watch: DemotionWatch,
  observations: ReadonlyArray<DemotedNodeObservation>,
  now: number,
  minDisagreementMs: number,
): DemotedWriteAlert[] {
  const alerts: DemotedWriteAlert[] = [];

  for (const observation of observations) {
    const entry = watch.get(observation.nodeId);
    if (entry === undefined) {
      continue;
    }

    if (observation.selfReportedRole !== 'master') {
      entry.disagreementSince = null;
      entry.consecutiveDisagreements = 0;
      entry.writeCallsBaseline = undefined;
      continue;
    }

    if (entry.disagreementSince === null) {
      entry.disagreementSince = now;
    }
    entry.consecutiveDisagreements += 1;

    const baseline = entry.writeCallsBaseline;
    if (observation.writeCommandCalls !== undefined) {
      entry.writeCallsBaseline = observation.writeCommandCalls;
    }

    // One alert per demotion window. The entry is dropped once the window
    // closes, so a later failover re-arms it.
    if (entry.alerted) {
      continue;
    }
    if (entry.consecutiveDisagreements < 2) {
      continue;
    }
    if (now - entry.disagreementSince < minDisagreementMs) {
      continue;
    }

    const writeCallsDelta = deltaSincePreviousPoll(observation.writeCommandCalls, baseline);
    if (writeCallsDelta !== undefined) {
      // Counted writes are the stronger evidence, so they replace the ops gate
      // rather than adding to it: instantaneous_ops_per_sec is a one-second
      // sample and reads zero for traffic that landed between polls.
      if (writeCallsDelta <= 0) {
        continue;
      }
    } else if (observation.opsPerSec <= 0) {
      continue;
    }

    entry.alerted = true;
    alerts.push({
      nodeId: observation.nodeId,
      nodeAddress: observation.nodeAddress,
      demotedForMs: now - entry.demotedAt,
      disagreementMs: now - entry.disagreementSince,
      opsPerSec: observation.opsPerSec,
      writeCallsDelta,
    });
  }

  return alerts;
}

/**
 * A counter that went backwards means the node restarted and re-baselined, not
 * that writes were undone. Returning undefined sends the caller to the
 * `opsPerSec` fallback for this poll instead of reporting a negative delta.
 */
function deltaSincePreviousPoll(current?: number, previous?: number): number | undefined {
  if (current === undefined || previous === undefined) {
    return undefined;
  }
  if (current < previous) {
    return undefined;
  }
  return current - previous;
}

export function demotedWritesMessage(alert: DemotedWriteAlert): string {
  const seconds = Math.round(alert.disagreementMs / 1000);
  const traffic =
    alert.writeCallsDelta === undefined
      ? `${alert.opsPerSec} ops/sec`
      : `${alert.writeCallsDelta} write commands`;
  return (
    `Node ${alert.nodeId} (${alert.nodeAddress}) was demoted to replica but still ` +
    `reports role:master after ${seconds}s and served ${traffic}. ` +
    `Writes accepted in this window are lost when clients refresh their slot cache.`
  );
}
