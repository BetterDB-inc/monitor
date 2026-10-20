import Valkey, { Cluster } from 'iovalkey';
import type { DatabaseConnectionConfig, Incompatibility } from '@betterdb/shared';
import { formatBytes } from '../../scaling-readiness/dimension-inputs';
import { createTargetClient } from '../execution/client-factory';
import { masterNodes } from '../validation/key-count-comparator';

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
  /** `used_memory_dataset`: memory held by keys, which a flush can free (the rest is baseline). */
  datasetMemory: number;
  /** This master's own maxmemory-policy. */
  policy: string;
  /** Keys in every db; with db0Keys, gives db0's share of datasetMemory. */
  keys: number;
  /** Keys in db0 only. */
  db0Keys: number;
  /** Keys with a TTL on this master (`expires=` summed over every db). */
  expires: number;
  /** Share of the hash slots this master owns, 0..1 (1 for a standalone target). */
  slotShare: number;
}

/** Memory picture of the whole target, one entry per master. */
export interface TargetMemory {
  masters: MasterMemory[];
  /** db0 keys summed over every master: what overlap checks compare against. */
  db0Keys: number;
}

/** Result of checking a sample of source keys against the target. */
export interface KeyOverlap {
  sampled: number;
  existing: number;
}

/** Above this share of a master's free memory the fit is called tight. */
export const TIGHT_FIT_RATIO = 0.9;
/**
 * The source estimate is sampled MEMORY USAGE scaled by key count, so a hard
 * block needs it to exceed what the master can hold by this factor.
 */
export const BLOCK_MARGIN = 1.1;
const OVERLAP_SAMPLE_LIMIT = 200;
const OVERLAP_BATCH = 50;

function infoField(info: string, field: string): string | undefined {
  return info.match(new RegExp(`^${field}:(.*)$`, 'm'))?.[1]?.trim();
}

function infoNumber(info: string, field: string): number {
  return Number(infoField(info, field) ?? 0) || 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Totals from an INFO keyspace reply. `keys` and `expires` cover every db
 * (eviction sees all of them); `db0Keys` is db0 only, the db that EXISTS,
 * the source sample and command mode see.
 */
export function keyspaceTotals(info: string): { keys: number; expires: number; db0Keys: number } {
  let keys = 0;
  let expires = 0;
  let db0Keys = 0;
  for (const match of info.matchAll(/^db(\d+):keys=(\d+),expires=(\d+)/gm)) {
    keys += Number(match[2]);
    expires += Number(match[3]);
    if (match[1] === '0') db0Keys = Number(match[2]);
  }
  return { keys, expires, db0Keys };
}

/** TTL counts from analysis's key sample (`ttlDistribution`). */
export interface TtlSample {
  sampled: number;
  noExpiry: number;
}

/**
 * Source keys with a TTL. Uses INFO keyspace when it shows any, then the key
 * sample (which spans every source master). Returns null when neither can
 * vouch for "none": no data, or a zero INFO read from one node of a cluster
 * with no usable sample.
 */
export function sourceExpiringKeysFrom(
  keyspaceInfo: string | null | undefined,
  coversWholeSource: boolean,
  ttlSample: TtlSample | null = null,
): number | null {
  const fromInfo = keyspaceInfo ? keyspaceTotals(keyspaceInfo).expires : null;
  if (fromInfo !== null && fromInfo > 0) return fromInfo;
  if (ttlSample && ttlSample.sampled > 0) return Math.max(0, ttlSample.sampled - ttlSample.noExpiry);
  if (fromInfo === 0 && coversWholeSource) return 0;
  return null;
}

/**
 * db0's share of the source's keys. Command mode copies db0 only, while the
 * analysis estimate scales by keys in every db. A cluster source only has db0.
 * Returns 1 when INFO keyspace is missing or empty.
 */
export function sourceDb0Share(
  keyspaceInfo: string | null | undefined,
  isClusterSource: boolean,
): number {
  if (isClusterSource || !keyspaceInfo) return 1;
  const { keys, db0Keys } = keyspaceTotals(keyspaceInfo);
  return keys > 0 ? db0Keys / keys : 1;
}

/**
 * Source size the capacity check compares against the target. The sampled
 * estimate is scaled to db0. When sampling produced no estimate, the source's
 * used_memory is used instead and flagged `rough`: it includes replication and
 * client buffers and allocator overhead, so it must not hard-block.
 */
export function capacitySourceSize(input: {
  estimatedBytes: number;
  db0Share: number;
  usedMemory: number;
}): { bytes: number; rough: boolean } {
  if (input.estimatedBytes > 0) {
    return { bytes: input.estimatedBytes * Math.min(1, Math.max(0, input.db0Share)), rough: false };
  }
  return { bytes: Math.max(0, input.usedMemory), rough: true };
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

/** Read memory, dataset size, policy, keys and TTL keys from every master of the target. */
export async function readTargetMemory(client: Valkey): Promise<TargetMemory> {
  const maybeCluster: unknown = client;
  const cluster = maybeCluster instanceof Cluster ? maybeCluster : null;
  const nodes = masterNodes(client);
  if (nodes.length === 0) throw new Error('No target masters available');
  const shares = cluster ? slotShares(cluster, nodes) : [1];

  const masters = await Promise.all(
    nodes.map(async (node, i): Promise<MasterMemory> => {
      const [memory, keyspace] = await Promise.all([node.info('memory'), node.info('keyspace')]);
      const { keys, expires, db0Keys } = keyspaceTotals(keyspace);
      return {
        name: cluster ? nodeName(node) : 'target',
        maxmemory: infoNumber(memory, 'maxmemory'),
        usedMemory: Math.max(
          0,
          infoNumber(memory, 'used_memory') - infoNumber(memory, 'mem_not_counted_for_evict'),
        ),
        datasetMemory: infoNumber(memory, 'used_memory_dataset'),
        policy: infoField(memory, 'maxmemory_policy') ?? 'noeviction',
        keys,
        db0Keys,
        expires,
        slotShare: shares[i],
      };
    }),
  );
  return { masters, db0Keys: masters.reduce((s, m) => s + m.db0Keys, 0) };
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

/**
 * Pick up to `limit` source keys round-robin across the source nodes they
 * were sampled from, so a sample filled node by node does not come only
 * from the first master.
 */
export function pickOverlapSample(
  keys: { key: string; clientIndex?: number }[],
  limit = OVERLAP_SAMPLE_LIMIT,
): string[] {
  const groups = new Map<number, string[]>();
  for (const k of keys) {
    const group = k.clientIndex ?? 0;
    const list = groups.get(group);
    if (list) list.push(k.key);
    else groups.set(group, [k.key]);
  }
  const queues = [...groups.values()];
  const picked: string[] = [];
  for (let i = 0; picked.length < limit; i++) {
    let added = false;
    for (const queue of queues) {
      if (i < queue.length && picked.length < limit) {
        picked.push(queue[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked;
}

type CapacityKind = 'tight' | 'flush' | 'marginal' | 'evict' | 'oom';
const KIND_RANK: Record<CapacityKind, number> = { tight: 1, flush: 2, marginal: 3, evict: 4, oom: 5 };

interface MasterFinding {
  master: MasterMemory;
  kind: CapacityKind;
  /** Bytes of the source this master is expected to receive. */
  need: number;
  /** Bytes this master can take now, before it reaches maxmemory. */
  free: number;
  /** Bytes this master could take after db0 is flushed. */
  roomAfterFlush: number;
  /** volatile-* policy and the source has no TTL keys, so its keys can't be evicted. */
  volatileNoSourceTtl: boolean;
}

/** Memory a FLUSHDB of db0 would free: db0's share of the dataset. 0 when db0 is empty. */
function flushableBytes(master: MasterMemory): number {
  if (master.db0Keys <= 0 || master.keys <= 0) return 0;
  return master.datasetMemory * Math.min(1, master.db0Keys / master.keys);
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
  const roomAfterFlush = Math.max(
    0,
    master.maxmemory - Math.max(0, master.usedMemory - flushableBytes(master)),
  );
  const volatile = master.policy.startsWith('volatile-');
  const volatileNoSourceTtl = volatile && sourceExpiringKeys === 0;
  const base = { master, need, free, roomAfterFlush, volatileNoSourceTtl };

  if (need <= free) {
    return need > free * TIGHT_FIT_RATIO ? { ...base, kind: 'tight' } : null;
  }

  // volatile-* only evicts keys with a TTL. It cannot evict when neither this
  // master nor the source has any, and when the source has none, evicting the
  // target's own TTL keys cannot make room for a source that alone exceeds
  // maxmemory. An unknown source count (null) is never treated as "none".
  const volatileCannotEvict =
    volatileNoSourceTtl && (master.expires === 0 || need > master.maxmemory * BLOCK_MARGIN);
  const canEvict = master.policy.startsWith('allkeys-') || (volatile && !volatileCannotEvict);
  if (canEvict) return { ...base, kind: 'evict' };

  // Cannot evict. A flush (emptyDbBeforeSync) frees db0's dataset, never the
  // baseline, so judge against the room a flush would leave.
  if (need > roomAfterFlush * BLOCK_MARGIN) return { ...base, kind: 'oom' };
  if (need <= roomAfterFlush) return { ...base, kind: 'flush' };
  return { ...base, kind: 'marginal' };
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

function volatileNote(f: MasterFinding): string {
  if (!f.volatileNoSourceTtl) return '';
  return f.master.expires === 0
    ? ` A '${f.master.policy}' policy only evicts keys with a TTL, and there are none on this target or in the source.`
    : ` A '${f.master.policy}' policy only evicts keys with a TTL, and the source has none, so evicting the target's own keys cannot make room for it.`;
}

/** Options for {@link checkTargetCapacity}. */
export interface CapacityCheckOptions {
  /**
   * The source size is the source's used_memory (MEMORY USAGE sampling was
   * unavailable), not a dataset estimate: report at most a warning.
   */
  roughSourceSize?: boolean;
}

/**
 * Will each target master hold its share of the source dataset? Every capped
 * master is judged on its own memory and policy; the worst one is reported.
 * Per master, with need = source x slot share:
 * - fits, but uses more than TIGHT_FIT_RATIO of free memory -> warning (tight).
 * - does not fit and the master can evict -> warning (evict).
 * - cannot evict, fits once db0 is flushed -> warning (empty it first).
 * - cannot evict, within BLOCK_MARGIN of the room after a flush -> warning (marginal).
 * - cannot evict, beyond BLOCK_MARGIN of the room after a flush -> blocking,
 *   unless the source size is rough, which caps it at a warning.
 * `sourceExpiringKeys` is null when the source's TTL key count is unknown.
 */
export function checkTargetCapacity(
  sourceBytes: number,
  target: TargetMemory,
  sourceExpiringKeys: number | null = null,
  options: CapacityCheckOptions = {},
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
  const afterFlush = formatBytes(worst.roomAfterFlush);

  if (worst.kind === 'oom') {
    if (options.roughSourceSize) {
      return [
        {
          severity: 'warning',
          category: 'capacity',
          title: 'Target may not have enough memory',
          detail: `${fit} (policy '${policy}'); about ${afterFlush} would be available after emptying it.${volatileNote(worst)} The source size here is its used_memory, because MEMORY USAGE sampling was unavailable, and that includes replication and client buffers, so this is not treated as a hard block. Check the source's dataset size before migrating.${spread}`,
        },
      ];
    }
    return [
      {
        severity: 'blocking',
        category: 'capacity',
        title: 'Target does not have enough memory',
        detail: `${fit} (policy '${policy}'). Even after emptying the target, only about ${afterFlush} would be available, so writes will fail with OOM part-way through the migration.${volatileNote(worst)} Raise maxmemory or add shards first.${spread}`,
      },
    ];
  }

  if (worst.kind === 'flush') {
    return [
      {
        severity: 'warning',
        category: 'capacity',
        title: 'Target only has room if it is emptied first',
        detail: `${fit} (policy '${policy}'). The source does not fit next to the data already on the target, but about ${afterFlush} would be available after emptying it, which is enough. Use a RedisShake mode with emptyDbBeforeSync or flush the target before migrating; otherwise writes fail with OOM part-way through.${volatileNote(worst)}${spread}`,
      },
    ];
  }

  if (worst.kind === 'marginal') {
    return [
      {
        severity: 'warning',
        category: 'capacity',
        title: 'Target memory may not hold the source',
        detail: `${fit} (policy '${policy}'). Even after emptying the target only about ${afterFlush} would be available, and the source estimate is within 10% of that, too close to call from a sampled estimate. Writes may fail with OOM part-way through; raise maxmemory or add shards before migrating.${volatileNote(worst)}${spread}`,
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

/** Does the target's db0 already hold data, and do source keys collide with it? */
export function checkKeyOverlap(targetKeys: number, overlap: KeyOverlap | null): Incompatibility[] {
  if (targetKeys <= 0) return [];
  if (!overlap || overlap.sampled === 0) {
    return [
      {
        severity: 'info',
        category: 'key_overlap',
        title: 'Key overlap was not checked',
        detail: `The target already holds ${targetKeys.toLocaleString()} keys in db0, but analysis sampled no source keys, so collisions with the target were not checked.`,
      },
    ];
  }
  if (overlap.existing > 0) {
    const pct = Math.round((overlap.existing / overlap.sampled) * 100);
    return [
      {
        severity: 'warning',
        category: 'key_overlap',
        title: 'Source keys already exist on the target',
        detail: `${overlap.existing} of ${overlap.sampled} sampled source keys (${pct}%) already exist on the target, which holds ${targetKeys.toLocaleString()} keys in db0. Command mode overwrites them; RedisShake modes stop with BUSYKEY unless the target is emptied first (emptyDbBeforeSync).`,
      },
    ];
  }
  return [
    {
      severity: 'info',
      category: 'key_overlap',
      title: 'Target is not empty',
      detail: `The target already holds ${targetKeys.toLocaleString()} keys in db0. None of the sampled source keys exist there, so they are not expected to collide, but the target's key count will not match the source after migration.`,
    },
  ];
}

/** Input for {@link probeTargetCapacity}. */
export interface CapacityProbeInput {
  targetConfig: DatabaseConnectionConfig;
  targetIsCluster: boolean;
  /** Source size for the capacity check, in bytes (0 when unknown). See capacitySourceSize. */
  sourceBytes: number;
  /** true when sourceBytes is the source's used_memory rather than a dataset estimate. */
  roughSourceSize?: boolean;
  /** Source key names to check on the target (see pickOverlapSample). */
  sampledKeys: string[];
  /** Source keys with a TTL; null or omitted when unknown. */
  sourceExpiringKeys?: number | null;
}

/**
 * Connect to the target with its own client (the adapter's INFO comes from a
 * single node), read memory and key counts from every master, and return the
 * `capacity` and `key_overlap` issues. Throws when the target's memory cannot
 * be read; the caller reports that the checks did not run. A failing overlap
 * step (e.g. EXISTS denied) only replaces the overlap result, so a capacity
 * finding is never lost.
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
    const capacity = checkTargetCapacity(
      input.sourceBytes,
      target,
      input.sourceExpiringKeys ?? null,
      { roughSourceSize: input.roughSourceSize === true },
    );
    let overlap: Incompatibility[];
    try {
      const sampled =
        target.db0Keys > 0 ? await sampleKeyOverlap(client, input.sampledKeys) : null;
      overlap = checkKeyOverlap(target.db0Keys, sampled);
    } catch (err: unknown) {
      overlap = [
        {
          severity: 'info',
          category: 'key_overlap',
          title: 'Key-overlap check did not run',
          detail: `Source keys could not be checked on the target (${errorMessage(err)}). Allow EXISTS for the target user, or check for colliding keys manually before migrating.`,
        },
      ];
    }
    return [...capacity, ...overlap];
  } finally {
    await client.quit().catch(() => undefined);
  }
}
