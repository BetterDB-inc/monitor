import { InfoParser } from '@app/database/parsers/info.parser';

export const REPLICATION_RATE_EWMA_ALPHA = 0.3;

const REPLICA_LINE_KEY = /^slave(\d+)$/;

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
  const parsed: Array<{ index: number; line: ReplicaOffsetLine }> = [];
  for (const [key, value] of Object.entries(info)) {
    const match = REPLICA_LINE_KEY.exec(key);
    if (!match || typeof value !== 'string') continue;
    const fields = InfoParser.parseKvLine(value, ',');
    const offset = toFiniteNumber(fields.offset);
    if (!fields.ip || !fields.port || offset === null) continue;
    parsed.push({
      index: Number(match[1]),
      line: {
        key,
        addr: `${fields.ip}:${fields.port}`,
        state: fields.state ?? 'unknown',
        offset,
        lagSec: toFiniteNumber(fields.lag),
      },
    });
  }
  return parsed.sort((a, b) => a.index - b.index).map((p) => p.line);
}

export class ReplicationStreamTracker {
  private baselines = new Map<string, StreamBaseline>();
  private samples = new Map<string, ReplicationStreamSample>();

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

    const isReplica = info.role === 'slave' || info.role === 'replica';
    const sample: ReplicationStreamSample = {
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
    this.samples.set(connectionId, sample);
    return sample;
  }

  latest(connectionId: string): ReplicationStreamSample | null {
    return this.samples.get(connectionId) ?? null;
  }

  forget(connectionId: string): void {
    this.baselines.delete(connectionId);
    this.samples.delete(connectionId);
  }
}
