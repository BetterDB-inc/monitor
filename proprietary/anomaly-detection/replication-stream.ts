import {
  isReplicaRole,
  parseReplicaLines as parseAllReplicaLines,
} from '@app/database/parsers/replication-info.parser';

export const REPLICATION_RATE_EWMA_ALPHA = 0.3;

export interface ReplicaOffsetLine {
  key: string;
  addr: string;
  state: string;
  offset: number;
  lagSec: number | null;
}

export interface ReplicaOffset extends ReplicaOffsetLine {
  gapBytes: number;
}

export interface ReplicationStreamSample {
  timestamp: number;
  role: 'primary' | 'replica';
  replid: string | null;
  masterReplOffset: number;
  bytesPerSec: number | null;
  bytesPerSecEwma: number | null;
  replBacklogSize: number | null;
  replicas: ReplicaOffset[];
}

interface StreamBaseline {
  replid: string | null;
  offset: number;
  ts: number;
  ewma: number | null;
}

function toFiniteNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseReplicaLines(info: Record<string, string>): ReplicaOffsetLine[] {
  return parseAllReplicaLines(info).flatMap(({ key, addr, state, offset, lagSec }) =>
    addr === null || offset === null
      ? []
      : [{ key, addr, state: state ?? 'unknown', offset, lagSec }],
  );
}

export class ReplicationStreamTracker {
  private baselines = new Map<string, StreamBaseline>();

  observe(
    connectionId: string,
    info: Record<string, string>,
    timestamp: number,
  ): ReplicationStreamSample | null {
    const masterReplOffset = toFiniteNumber(info.master_repl_offset);
    if (masterReplOffset === null) return null;

    const replid = info.master_replid || null;
    const prev = this.baselines.get(connectionId);
    const secondReplOffset = toFiniteNumber(info.second_repl_offset);
    const continuesHistory =
      prev !== undefined &&
      (prev.replid === replid ||
        (prev.replid !== null &&
          info.master_replid2 === prev.replid &&
          secondReplOffset !== null &&
          prev.offset <= secondReplOffset));

    let bytesPerSec: number | null = null;
    let ewma: number | null = null;
    if (prev !== undefined && continuesHistory && masterReplOffset >= prev.offset) {
      const dtSec = (timestamp - prev.ts) / 1000;
      if (dtSec > 0) {
        bytesPerSec = (masterReplOffset - prev.offset) / dtSec;
        ewma =
          prev.ewma === null
            ? bytesPerSec
            : REPLICATION_RATE_EWMA_ALPHA * bytesPerSec +
              (1 - REPLICATION_RATE_EWMA_ALPHA) * prev.ewma;
      } else {
        ewma = prev.ewma;
      }
    }

    this.baselines.set(connectionId, { replid, offset: masterReplOffset, ts: timestamp, ewma });

    const isReplica = isReplicaRole(info.role);
    return {
      timestamp,
      role: isReplica ? 'replica' : 'primary',
      replid,
      masterReplOffset,
      bytesPerSec,
      bytesPerSecEwma: bytesPerSec === null ? null : ewma,
      replBacklogSize: toFiniteNumber(info.repl_backlog_size),
      replicas: isReplica
        ? []
        : parseReplicaLines(info).map((line) => ({
            ...line,
            gapBytes: Math.max(0, masterReplOffset - line.offset),
          })),
    };
  }

  forget(connectionId: string): void {
    this.baselines.delete(connectionId);
  }
}
