import { formatBytes } from '@app/scaling-readiness/dimension-inputs';
import { isReplicaRole, toFiniteNumber } from '@app/database/parsers/replication-info.parser';
import { DIVERGENCE_FLOOR_BYTES } from './replication-divergence-detector';

export interface ReplicaView {
  gapBytes: number;
  linkStatus: string | null;
  applyBacklogBytes: number | null;
}

export function readReplicaView(
  replica: Record<string, string>,
  primary: Record<string, string>,
): ReplicaView | null {
  if (!isReplicaRole(replica.role)) return null;
  const primaryOffset = toFiniteNumber(primary.master_repl_offset);
  const offset = toFiniteNumber(replica.slave_repl_offset);
  if (primaryOffset === null || offset === null) return null;
  if (!primary.master_replid || replica.master_replid !== primary.master_replid) return null;
  const readOffset = toFiniteNumber(replica.slave_read_repl_offset);
  return {
    gapBytes: Math.max(0, primaryOffset - offset),
    linkStatus: replica.master_link_status || null,
    applyBacklogBytes: readOffset === null ? null : Math.max(0, readOffset - offset),
  };
}

export function replicaCaughtUp(view: ReplicaView): boolean {
  return view.linkStatus === 'up' && view.gapBytes < DIVERGENCE_FLOOR_BYTES;
}

export function describeReplicaView(view: ReplicaView): string {
  if (view.linkStatus !== 'up') {
    return ` The replica reports its link to the primary is ${view.linkStatus ?? 'unknown'} and it is ${formatBytes(view.gapBytes)} behind.`;
  }
  const reported = ` The replica confirms it is ${formatBytes(view.gapBytes)} behind`;
  if (view.applyBacklogBytes === null) return `${reported}.`;
  if (view.applyBacklogBytes === 0) {
    return `${reported}; it has applied everything it received, so the stream is not reaching it fast enough.`;
  }
  const unapplied = `${reported}; it has received ${formatBytes(view.applyBacklogBytes)} it has not applied yet`;
  return view.applyBacklogBytes >= DIVERGENCE_FLOOR_BYTES ? `${unapplied}, so it is slow to apply.` : `${unapplied}.`;
}
