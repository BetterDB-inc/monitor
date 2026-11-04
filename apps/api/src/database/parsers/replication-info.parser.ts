import { InfoParser } from './info.parser';

const REPLICA_LINE_KEY = /^(?:slave|replica)(\d+)$/;
const REPLICA_ROLES: ReadonlySet<string> = new Set(['slave', 'replica', 'active-replica']);

export interface ReplicaLine {
  key: string;
  index: number;
  addr: string | null;
  state: string | null;
  offset: number | null;
  lagSec: number | null;
}

export function isReplicaRole(role: string | undefined): boolean {
  return role !== undefined && REPLICA_ROLES.has(role);
}

export function hasReplicaLines(replication: Record<string, string>): boolean {
  return Object.keys(replication).some((key) => REPLICA_LINE_KEY.test(key));
}

export function parseReplicaLines(replication: Record<string, string>): ReplicaLine[] {
  const lines: ReplicaLine[] = [];
  for (const [key, value] of Object.entries(replication)) {
    const match = REPLICA_LINE_KEY.exec(key);
    if (!match || typeof value !== 'string') continue;
    const fields = InfoParser.parseKvLine(value, ',');
    lines.push({
      key,
      index: Number(match[1]),
      addr: fields.ip && fields.port ? `${fields.ip}:${fields.port}` : null,
      state: fields.state ?? null,
      offset: toFiniteNumber(fields.offset),
      lagSec: toFiniteNumber(fields.lag),
    });
  }
  return lines.sort((a, b) => a.index - b.index);
}

export function toFiniteNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
