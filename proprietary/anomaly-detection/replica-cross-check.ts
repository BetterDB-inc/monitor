import { formatBytes } from '@app/scaling-readiness/dimension-inputs';
import { isReplicaRole, toFiniteNumber } from '@app/database/parsers/replication-info.parser';
import { DIVERGENCE_FLOOR_BYTES, ReplicaViewReading, ReplicaViewStatus } from './replication-divergence-detector';
import { parseReplicaOffsetLines } from './replication-stream';

export interface ReplicaView {
  gapBytes: number;
  linkStatus: string | null;
  applyBacklogBytes: number | null;
}

export type ReplicaSample =
  | { status: 'ok'; view: ReplicaView; primaryGapBytes: number | null }
  | { status: Exclude<ReplicaViewStatus, 'ok'>; view: null; primaryGapBytes: null };

export const UNREACHABLE_REPLICA: ReplicaSample = { status: 'unreachable', view: null, primaryGapBytes: null };

export function sampleReplicaView(
  replica: Record<string, string>,
  primary: Record<string, string>,
  addr: string,
): ReplicaSample {
  if (!isReplicaRole(replica.role)) return { status: 'not_replica', view: null, primaryGapBytes: null };
  const offset = toFiniteNumber(replica.slave_repl_offset);
  const primaryOffset = toFiniteNumber(primary.master_repl_offset);
  if (offset === null || primaryOffset === null) return UNREACHABLE_REPLICA;
  if (!primary.master_replid || replica.master_replid !== primary.master_replid) {
    return { status: 'replid_mismatch', view: null, primaryGapBytes: null };
  }
  const readOffset = toFiniteNumber(replica.slave_read_repl_offset);
  const acked = parseReplicaOffsetLines(primary).find((line) => line.addr === addr);
  return {
    status: 'ok',
    view: {
      gapBytes: Math.max(0, primaryOffset - offset),
      linkStatus: replica.master_link_status || null,
      applyBacklogBytes: readOffset === null ? null : Math.max(0, readOffset - offset),
    },
    primaryGapBytes: acked ? Math.max(0, primaryOffset - acked.offset) : null,
  };
}

export function replicaReadings(samples: ReadonlyMap<string, ReplicaSample>): Map<string, ReplicaViewReading> {
  return new Map(
    [...samples].map(([addr, { status, view, primaryGapBytes }]) => [
      addr,
      { status, gapBytes: view?.gapBytes ?? null, linkUp: view?.linkStatus === 'up', primaryGapBytes },
    ]),
  );
}

export function replicaCaughtUp(view: ReplicaView): boolean {
  return view.linkStatus === 'up' && view.gapBytes < DIVERGENCE_FLOOR_BYTES;
}

export function describeReplicaView(view: ReplicaView, staleAcks = false): string {
  if (view.linkStatus !== 'up') {
    return ` The replica reports its link to the primary is ${view.linkStatus ?? 'unknown'} and it is ${formatBytes(view.gapBytes)} behind.`;
  }
  if (staleAcks && replicaCaughtUp(view)) {
    return ` The replica reports it is only ${formatBytes(view.gapBytes)} behind, so its acknowledgements are not reaching the primary.`;
  }
  const reported = ` The replica confirms it is ${formatBytes(view.gapBytes)} behind`;
  if (view.applyBacklogBytes === null) return `${reported}.`;
  if (view.applyBacklogBytes === 0) {
    return `${reported}; it has applied everything it received, so the stream is not reaching it fast enough.`;
  }
  const unapplied = `${reported}; it has received ${formatBytes(view.applyBacklogBytes)} it has not applied yet`;
  return view.applyBacklogBytes >= DIVERGENCE_FLOOR_BYTES ? `${unapplied}, so it is slow to apply.` : `${unapplied}.`;
}
