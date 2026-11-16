export const LABEL = 'sbb.bench=697';
export const BASE_IMAGE = 'valkey/valkey:9.1.3-alpine';
export const IMAGE = 'sbb-valkey:9.1.3';
export const ZONES = ['sbb-a', 'sbb-b', 'sbb-c'];
export const VALKEY_PORT = 6379;
export const HOST_PORT_BASE = 7300;
export const SUBNET_PREFIX = '172.30';
export const SUBNET_BASE = 100;

export const TICK_MS = 1_000;
export const PROBE_TIMEOUT_MS = 2_000;
export const CONNECT_TIMEOUT_MS = 1_000;
export const BASELINE_MS = 15_000;
export const TAIL_MS = 60_000;

export type Role = 'primary' | 'replica' | 'joiner';

export interface NodeSpec {
  name: string;
  container: string;
  ip: string;
  hostPort: number;
  zone: string;
  role: Role;
  primary?: string;
}

export interface LaneSpec {
  lane: number;
  network: string;
  subnet: string;
  nodes: NodeSpec[];
  joiner: NodeSpec;
}

export function laneSpec(lane: number, size = 6): LaneSpec {
  if (size % 2 !== 0 || size < 6) throw new Error(`cluster size must be even and at least 6, got ${size}`);
  const shards = size / 2;
  const prefix = `${SUBNET_PREFIX}.${SUBNET_BASE + lane}`;
  const byZone: Array<Array<{ role: Role; shard: number }>> = ZONES.map(() => []);
  for (let shard = 0; shard < shards; shard++) {
    byZone[shard % ZONES.length].push({ role: 'primary', shard });
    byZone[(shard + 1) % ZONES.length].push({ role: 'replica', shard });
  }
  const ordered = byZone.flatMap((members, zone) => members.map((member) => ({ ...member, zone })));
  const nameOfPrimary = new Map<number, string>();
  ordered.forEach((member, index) => {
    if (member.role === 'primary') nameOfPrimary.set(member.shard, `n${index + 1}`);
  });
  const node = (index: number, zone: string, role: Role, primary?: string): NodeSpec => ({
    name: `n${index + 1}`,
    container: `sbb-l${lane}-n${index + 1}`,
    ip: `${prefix}.${11 + index}`,
    hostPort: HOST_PORT_BASE + lane * 10 + index + 1,
    zone,
    role,
    primary,
  });
  const nodes = ordered.map((member, index) =>
    node(
      index,
      ZONES[member.zone],
      member.role,
      member.role === 'replica' ? nameOfPrimary.get(member.shard) : undefined,
    ),
  );
  return {
    lane,
    network: `sbb-l${lane}`,
    subnet: `${prefix}.0/24`,
    nodes,
    joiner: node(size, ZONES[0], 'joiner'),
  };
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts: Array<string | number>): number {
  let hash = 2166136261;
  for (const char of parts.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(Math.floor(random() * items.length), items.length - 1)];
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
