import Valkey, { Cluster } from 'iovalkey';
import type { DatabaseConnectionConfig, Incompatibility } from '@betterdb/shared';
import { formatBytes } from '../../scaling-readiness/dimension-inputs';
import { createTargetClient } from '../execution/client-factory';

/** Memory picture of one target master (the whole instance for a standalone target). */
export interface MasterMemory {
  /** `host:port` of the master, or `'target'` for a standalone target. */
  name: string;
  /** 0 when this master has no maxmemory limit. */
  maxmemory: number;
  /**
   * `used_memory - mem_not_counted_for_evict`: the figure Valkey compares with
   * maxmemory before it evicts or rejects writes (replication and AOF buffers
   * are excluded).
   */
  usedMemory: number;
  /** This master's own maxmemory-policy. */
  policy: string;
  keys: number;
  /** Keys with a TTL on this master (`expires=` summed over every db). */
  expires: number;
  /** Share of the hash slots this master owns, 0..1 (1 for a standalone target). */
  slotShare: number;
}

/** Memory picture of the whole target, one entry per master. */
export interface TargetMemory {
  masters: MasterMemory[];
  /** Keys summed over every master. */
  keys: number;
}

/** Result of checking a sample of source keys against the target. */
export interface KeyOverlap {
  sampled: number;
  existing: number;
}

/** Above this share of a master's free memory the fit is called tight. */
export const TIGHT_FIT_RATIO = 0.9;
const OVERLAP_SAMPLE_LIMIT = 200;
const OVERLAP_BATCH = 50;

function infoField(info: string, field: string): string | undefined {
  return info.match(new RegExp(`^${field}:(.*)$`, 'm'))?.[1]?.trim();
}

function infoNumber(info: string, field: string): number {
  return Number(infoField(info, field) ?? 0) || 0;
}

/** Sum `keys=` and `expires=` over every db line of an INFO keyspace reply. */
export function keyspaceTotals(info: string): { keys: number; expires: number } {
  let keys = 0;
  let expires = 0;
  for (const match of info.matchAll(/^db\d+:keys=(\d+),expires=(\d+)/gm)) {
    keys += Number(match[1]);
    expires += Number(match[2]);
  }
  return { keys, expires };
}

/**
 * Source keys with a TTL, from the source's INFO keyspace. Returns null when
 * the count cannot be trusted: no INFO at all, or a zero read from only part of
 * a clustered source (other masters may hold TTL keys).
 */
export function sourceExpiringKeysFrom(
  keyspaceInfo: string | null | undefined,
  coversWholeSource: boolean,
): number | null {
  if (!keyspaceInfo) return null;
  const { expires } = keyspaceTotals(keyspaceInfo);
  if (expires > 0) return expires;
  return coversWholeSource ? 0 : null;
}

function nodeName(node: Valkey): string {
  const { host, port } = node.options ?? {};
  return `${host ?? 'unknown'}:${port ?? 'unknown'}`;
}

/**
 * Fraction of the hash slots each master owns, read from the cluster's slot
 * map. Falls back to equal shares when the map is empty or its node keys do
 * not match the masters (e.g. NAT-mapped addresses).
 */
function slotShares(cluster: Cluster, masters: Valkey[]): number[] {
  const owned = new Map<string, number>();
  const slots = (cluster as unknown as { slots?: string[][] }).slots ?? [];
  for (const owners of slots) {
    const owner = owners?.[0];
    if (owner) owned.set(owner, (owned.get(owner) ?? 0) + 1);
  }
  const counts = masters.map((m) => owned.get(nodeName(m)) ?? 0);
  const matched = counts.reduce((s, c) => s + c, 0);
  if (matched === 0) return masters.map(() => 1 / masters.length);
  return counts.map((c) => c / matched);
}

/** Read maxmemory, evictable used memory, policy, keys and TTL keys from every master of the target. */
export async function readTargetMemory(client: Valkey): Promise<TargetMemory> {
  const maybeCluster: unknown = client;
  const cluster = maybeCluster instanceof Cluster ? maybeCluster : null;
  const nodes: Valkey[] = cluster ? cluster.nodes('master') : [client];
  if (nodes.length === 0) throw new Error('No target masters available');
  const shares = cluster ? slotShares(cluster, nodes) : [1];

  const masters = await Promise.all(
    nodes.map(async (node, i): Promise<MasterMemory> => {
      const [memory, keyspace] = await Promise.all([node.info('memory'), node.info('keyspace')]);
      const { keys, expires } = keyspaceTotals(keyspace);
      return {
        name: cluster ? nodeName(node) : 'target',
        maxmemory: infoNumber(memory, 'maxmemory'),
        usedMemory: Math.max(
          0,
          infoNumber(memory, 'used_memory') - infoNumber(memory, 'mem_not_counted_for_evict'),
        ),
        policy: infoField(memory, 'maxmemory_policy') ?? 'noeviction',
        keys,
        expires,
        slotShare: shares[i],
      };
    }),
  );
  return { masters, keys: masters.reduce((s, m) => s + m.keys, 0) };
}

/** EXISTS a sample of source keys on the target, one key per call so cluster routing works. */
export async function sampleKeyOverlap(target: Valkey, keys: string[]): Promise<KeyOverlap> {
  const sample = keys.slice(0, OVERLAP_SAMPLE_LIMIT);
  let existing = 0;
  for (let i = 0; i < sample.length; i += OVERLAP_BATCH) {
    const batch = sample.slice(i, i + OVERLAP_BATCH);
    const results = await Promise.all(batch.map((key) => target.exists(key)));
    existing += results.filter((n) => n > 0).length;
  }
  return { sampled: sample.length, existing };
}

type CapacityKind = 'tight' | 'evict' | 'oom';
const KIND_RANK: Record<CapacityKind, number> = { tight: 1, evict: 2, oom: 3 };

interface MasterFinding {
  master: MasterMemory;
  kind: CapacityKind;
  /** Bytes of the source this master is expected to receive. */
  need: number;
  /** Bytes this master can take before it reaches maxmemory. */
  free: number;
  /** volatile-* policy with no TTL keys on the master or in the source. */
  noEvictionCandidates: boolean;
}

function assessMaster(
  sourceBytes: number,
  master: MasterMemory,
  sourceExpiringKeys: number | null,
): MasterFinding | null {
  if (master.maxmemory <= 0) return null;
  const need = sourceBytes * master.slotShare;
  if (need <= 0) return null;
  const free = Math.max(0, master.maxmemory - master.usedMemory);
  const base = { master, need, free, noEvictionCandidates: false };

  if (need > free) {
    if (master.policy.startsWith('allkeys-')) return { ...base, kind: 'evict' };
    if (master.policy.startsWith('volatile-')) {
      // volatile-* only evicts keys with a TTL. With none on this master and none
      // arriving from the source, Valkey behaves like noeviction. An unknown
      // source count (null) is not treated as "none".
      const noCandidates = master.expires === 0 && sourceExpiringKeys === 0;
      return noCandidates
        ? { ...base, kind: 'oom', noEvictionCandidates: true }
        : { ...base, kind: 'evict' };
    }
    return { ...base, kind: 'oom' };
  }
  if (need > free * TIGHT_FIT_RATIO) return { ...base, kind: 'tight' };
  return null;
}

function overflowRatio(f: MasterFinding): number {
  return f.free === 0 ? Number.POSITIVE_INFINITY : f.need / f.free;
}

function worstFinding(findings: MasterFinding[]): MasterFinding {
  return findings.reduce((worst, f) => {
    const byKind = KIND_RANK[f.kind] - KIND_RANK[worst.kind];
    if (byKind !== 0) return byKind > 0 ? f : worst;
    return overflowRatio(f) > overflowRatio(worst) ? f : worst;
  });
}

function describeFit(f: MasterFinding, sourceBytes: number, clustered: boolean): string {
  const have = `${formatBytes(f.free)} free of ${formatBytes(f.master.maxmemory)} maxmemory`;
  if (!clustered) {
    return `The source dataset is about ${formatBytes(sourceBytes)}; the target has ${have}`;
  }
  const pct = Math.round(f.master.slotShare * 100);
  return `The source dataset is about ${formatBytes(sourceBytes)}. Target master ${f.master.name} owns about ${pct}% of the hash slots, so it receives about ${formatBytes(f.need)}; it has ${have}`;
}

/**
 * Will each target master hold its share of the source dataset?
 * Every master is judged on its own memory and policy; masters without a
 * maxmemory limit are skipped. The worst master is reported:
 * - cannot evict (noeviction, or volatile-* with no TTL keys on the master or
 *   in the source) and does not fit -> blocking: writes fail with OOM part-way.
 * - evicts (allkeys-*, volatile-* with TTL keys) and does not fit -> warning.
 * - fits, but uses more than TIGHT_FIT_RATIO of free memory -> warning.
 * `sourceExpiringKeys` is null when the source's TTL key count is unknown.
 */
export function checkTargetCapacity(
  sourceBytes: number,
  target: TargetMemory,
  sourceExpiringKeys: number | null = null,
): Incompatibility[] {
  if (sourceBytes <= 0) return [];
  const findings = target.masters
    .map((m) => assessMaster(sourceBytes, m, sourceExpiringKeys))
    .filter((f): f is MasterFinding => f !== null);
  if (findings.length === 0) return [];

  const worst = worstFinding(findings);
  const clustered = target.masters.length > 1;
  const fit = describeFit(worst, sourceBytes, clustered);
  const spread =
    clustered && findings.length > 1
      ? ` ${findings.length} of ${target.masters.length} target masters are flagged; this one has the least room.`
      : '';
  const policy = worst.master.policy;

  if (worst.kind === 'oom') {
    const why = worst.noEvictionCandidates
      ? `A '${policy}' policy only evicts keys with a TTL, and there are none on this target or in the source, so writes will fail with OOM part-way through the migration.`
      : 'Writes will fail with OOM part-way through the migration.';
    return [
      {
        severity: 'blocking',
        category: 'capacity',
        title: 'Target does not have enough memory',
        detail: `${fit} (policy '${policy}'). ${why} Raise maxmemory, add shards, or free memory on the target first.${spread}`,
      },
    ];
  }

  if (worst.kind === 'evict') {
    const oomNote = policy.startsWith('volatile-')
      ? ', and writes fail with OOM once no keys with a TTL are left to evict'
      : '';
    return [
      {
        severity: 'warning',
        category: 'capacity',
        title: 'Target will evict data during migration',
        detail: `${fit}. With '${policy}' the target will evict about ${formatBytes(worst.need - worst.free)} while it is being filled${oomNote}. Raise maxmemory or add shards before migrating.${spread}`,
      },
    ];
  }

  return [
    {
      severity: 'warning',
      category: 'capacity',
      title: 'Target memory is tight',
      detail: `${fit}. That leaves under ${Math.round((1 - TIGHT_FIT_RATIO) * 100)}% headroom, and encoding or fragmentation differences between engines can use it up.${spread}`,
    },
  ];
}

/** Does the target already hold data, and do source keys collide with it? */
export function checkKeyOverlap(targetKeys: number, overlap: KeyOverlap | null): Incompatibility[] {
  if (targetKeys <= 0) return [];
  if (overlap && overlap.existing > 0 && overlap.sampled > 0) {
    const pct = Math.round((overlap.existing / overlap.sampled) * 100);
    return [
      {
        severity: 'warning',
        category: 'key_overlap',
        title: 'Source keys already exist on the target',
        detail: `${overlap.existing} of ${overlap.sampled} sampled source keys (${pct}%) already exist on the target, which holds ${targetKeys.toLocaleString()} keys. Command mode overwrites them; RedisShake modes stop with BUSYKEY unless the target is emptied first (emptyDbBeforeSync).`,
      },
    ];
  }
  return [
    {
      severity: 'info',
      category: 'key_overlap',
      title: 'Target is not empty',
      detail: `The target already holds ${targetKeys.toLocaleString()} keys. None of the sampled source keys exist there, so they are not expected to collide, but the target's key count will not match the source after migration.`,
    },
  ];
}

/** Input for {@link probeTargetCapacity}. */
export interface CapacityProbeInput {
  targetConfig: DatabaseConnectionConfig;
  targetIsCluster: boolean;
  /** Estimated source dataset size in bytes (0 when unknown). */
  sourceBytes: number;
  /** Source key names already sampled by analysis. */
  sampledKeys: string[];
  /** Source keys with a TTL; null or omitted when unknown. */
  sourceExpiringKeys?: number | null;
}

/**
 * Connect to the target with its own client (the adapter's INFO comes from a
 * single node), read memory and key counts from every master, and return the
 * `capacity` and `key_overlap` issues. Throws when the target cannot be probed;
 * the caller treats that as "nothing to report".
 */
export async function probeTargetCapacity(input: CapacityProbeInput): Promise<Incompatibility[]> {
  const client = createTargetClient(
    input.targetConfig,
    'BetterDB-Migration-Analysis-Target',
    input.targetIsCluster,
  );
  try {
    await client.connect();
    const target = await readTargetMemory(client);
    const overlap = target.keys > 0 ? await sampleKeyOverlap(client, input.sampledKeys) : null;
    return [
      ...checkTargetCapacity(input.sourceBytes, target, input.sourceExpiringKeys ?? null),
      ...checkKeyOverlap(target.keys, overlap),
    ];
  } finally {
    await client.quit().catch(() => undefined);
  }
}
