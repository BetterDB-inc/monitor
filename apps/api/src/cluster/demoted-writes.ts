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
  /** The previous poll's raw write counter, for the next poll's delta. */
  lastWriteCalls?: number;
  /**
   * Write calls counted since the disagreement began, summed across polls
   * rather than derived from a pinned baseline, so evidence gathered before
   * the alert's gates open is still there when they do.
   */
  writeCallsSeen: number;
  /**
   * Whether every poll in the window could be attributed. A poll with no
   * commandstats, or one whose counter had been reset, leaves writes
   * unaccounted for — a total of zero then means "not seen", not "none".
   */
  writeCallsComplete: boolean;
  /**
   * The highest `opsPerSec` seen since the disagreement began. Kept rather than
   * read fresh at alert time because it is a one-second sample: the poll that
   * clears the gates may land in a quiet moment and read zero.
   */
  peakOpsPerSec: number;
  alerted: boolean;
}

/** Nodes demoted recently enough that traffic on them still means data loss. */
export type DemotionWatch = Map<string, DemotedNodeWatchEntry>;

export interface DemotedWriteAlert {
  nodeId: string;
  nodeAddress: string;
  demotedForMs: number;
  disagreementMs: number;
  /** The busiest one-second sample seen since the disagreement began. */
  opsPerSec: number;
  /**
   * Write calls counted since the disagreement began. Absent when nothing
   * could be counted — the node exposes no commandstats, or its counter was
   * reset — and the alert then rests on `opsPerSec` alone, saying "traffic"
   * rather than "writes".
   */
  writeCallsDelta?: number;
  /**
   * `critical` only when writes were actually counted, because only then is
   * data known to be going missing. Traffic that could not be attributed is
   * `warning`: `opsPerSec` totals every command, so a demoted node serving
   * nothing but reads reaches this point with no data loss to report, and
   * paging on it trains an operator to ignore the alert that matters.
   */
  severity: 'critical' | 'warning';
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
      writeCallsSeen: 0,
      writeCallsComplete: true,
      peakOpsPerSec: 0,
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
 * count computable — the first only establishes the counter's starting point.
 * The count alone is not the persistence guarantee, because `/metrics` scrapes
 * drive the same update path as the poller and two of them can land
 * milliseconds apart; the disagreement must also have lasted
 * `minDisagreementMs`, the caller's poll interval.
 *
 * Everything the alert rests on is accumulated across the window rather than
 * read off the poll that happens to clear the gates: writes are summed poll by
 * poll, and the ops reading is the peak seen since the disagreement began.
 *
 * Mutates `watch` — that accumulated state is what makes the persistence
 * requirement work across polls.
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
      entry.lastWriteCalls = undefined;
      entry.writeCallsSeen = 0;
      entry.writeCallsComplete = true;
      entry.peakOpsPerSec = 0;
      continue;
    }

    if (entry.disagreementSince === null) {
      entry.disagreementSince = now;
    }
    entry.consecutiveDisagreements += 1;

    // Recorded before the gates, never after: an observation that does not
    // clear them still saw what it saw.
    entry.peakOpsPerSec = Math.max(entry.peakOpsPerSec, observation.opsPerSec);
    accumulateWriteCalls(entry, observation.writeCommandCalls);

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

    // Counted writes are the stronger evidence, so they replace the ops gate
    // rather than adding to it: instantaneous_ops_per_sec is a one-second
    // sample and reads zero for traffic that landed between polls.
    if (entry.writeCallsSeen === 0) {
      // A zero total rules the node out only when every poll was attributable.
      // Otherwise the writes may simply have gone uncounted, and the peak ops
      // sample is the only evidence left.
      if (entry.writeCallsComplete) {
        continue;
      }
      if (entry.peakOpsPerSec <= 0) {
        continue;
      }
    }

    entry.alerted = true;
    const counted = entry.writeCallsSeen > 0;
    alerts.push({
      nodeId: observation.nodeId,
      nodeAddress: observation.nodeAddress,
      demotedForMs: now - entry.demotedAt,
      disagreementMs: now - entry.disagreementSince,
      opsPerSec: entry.peakOpsPerSec,
      writeCallsDelta: counted ? entry.writeCallsSeen : undefined,
      severity: counted ? 'critical' : 'warning',
    });
  }

  return alerts;
}

/**
 * Fold one poll's raw write counter into the running total.
 *
 * A counter that went backwards means the node restarted or its stats were
 * reset, not that writes were undone: the reading becomes the new starting
 * point and the writes already counted are kept. Both that and a poll with no
 * commandstats leave writes unaccounted for, so the window stops being able to
 * prove the node served none.
 */
function accumulateWriteCalls(entry: DemotedNodeWatchEntry, current?: number): void {
  if (current === undefined) {
    entry.writeCallsComplete = false;
    return;
  }

  const previous = entry.lastWriteCalls;
  entry.lastWriteCalls = current;
  if (previous === undefined) {
    return;
  }
  if (current < previous) {
    entry.writeCallsComplete = false;
    return;
  }
  entry.writeCallsSeen += current - previous;
}

/**
 * Only the counted-writes form states that writes were lost. `opsPerSec` totals
 * every command, reads included, so a node whose commandstats could not be read
 * may have served nothing but reads — the message reports the unattributed
 * traffic and names what has to be checked, rather than asserting data loss the
 * observation cannot support.
 */
export function demotedWritesMessage(alert: DemotedWriteAlert): string {
  const seconds = Math.round(alert.disagreementMs / 1000);
  const preamble =
    `Node ${alert.nodeId} (${alert.nodeAddress}) was demoted to replica but still ` +
    `reports role:master after ${seconds}s and served `;

  if (alert.writeCallsDelta === undefined) {
    return (
      `${preamble}${alert.opsPerSec} ops/sec at peak. The read/write split was ` +
      `unavailable, so this traffic may have been reads only. Check whether the ` +
      `node took writes: any it accepted are lost when clients refresh their ` +
      `slot cache.`
    );
  }

  return (
    `${preamble}${alert.writeCallsDelta} write commands. ` +
    `Writes accepted in this window are lost when clients refresh their slot cache.`
  );
}
