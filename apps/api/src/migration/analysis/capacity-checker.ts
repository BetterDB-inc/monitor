import Valkey, { Cluster } from 'iovalkey';
import type { DatabaseConnectionConfig, Incompatibility } from '@betterdb/shared';
import { formatBytes } from '../../scaling-readiness/dimension-inputs';
import { createTargetClient } from '../execution/client-factory';

/** Memory picture of the target, summed over every master on a cluster. */
export interface TargetMemory {
  /** 0 when any master has no maxmemory limit. */
  maxmemory: number;
  usedMemory: number;
  /** maxmemory-policy, or 'mixed' when masters disagree. */
  policy: string;
  keys: number;
}

export interface KeyOverlap {
  sampled: number;
  existing: number;
}

/** Above this share of the target's free memory the fit is called tight. */
export const TIGHT_FIT_RATIO = 0.9;
const OVERLAP_SAMPLE_LIMIT = 200;
const OVERLAP_BATCH = 50;

function infoField(info: string, field: string): string | undefined {
  return info.match(new RegExp(`^${field}:(.*)$`, 'm'))?.[1]?.trim();
}

function keysFromKeyspace(info: string): number {
  let total = 0;
  for (const match of info.matchAll(/^db\d+:keys=(\d+)/gm)) total += Number(match[1]);
  return total;
}

/** Read maxmemory / used_memory / policy / key count from every master of the target. */
export async function readTargetMemory(client: Valkey): Promise<TargetMemory> {
  const maybeCluster: unknown = client;
  const nodes: Valkey[] = maybeCluster instanceof Cluster ? maybeCluster.nodes('master') : [client];
  if (nodes.length === 0) throw new Error('No target masters available');

  const perNode = await Promise.all(
    nodes.map(async (node) => {
      const [memory, keyspace] = await Promise.all([node.info('memory'), node.info('keyspace')]);
      return {
        maxmemory: Number(infoField(memory, 'maxmemory') ?? 0) || 0,
        usedMemory: Number(infoField(memory, 'used_memory') ?? 0) || 0,
        policy: infoField(memory, 'maxmemory_policy') ?? 'noeviction',
        keys: keysFromKeyspace(keyspace),
      };
    }),
  );

  const policies = new Set(perNode.map((n) => n.policy));
  return {
    maxmemory: perNode.some((n) => n.maxmemory === 0)
      ? 0
      : perNode.reduce((s, n) => s + n.maxmemory, 0),
    usedMemory: perNode.reduce((s, n) => s + n.usedMemory, 0),
    policy: policies.size === 1 ? [...policies][0] : 'mixed',
    keys: perNode.reduce((s, n) => s + n.keys, 0),
  };
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
 * Will the source dataset fit in what the target has free?
 * - noeviction (or mixed policies) and it does not fit -> blocking: writes fail with OOM part-way through.
 * - an eviction policy and it does not fit -> warning: the target evicts while it is being filled.
 * - fits, but uses more than TIGHT_FIT_RATIO of free memory -> warning.
 * No limit on the target (maxmemory 0) -> nothing to check.
 */
export function checkTargetCapacity(sourceBytes: number, target: TargetMemory): Incompatibility[] {
  if (sourceBytes <= 0 || target.maxmemory <= 0) return [];

  const free = Math.max(0, target.maxmemory - target.usedMemory);
  const need = formatBytes(sourceBytes);
  const have = `${formatBytes(free)} free of ${formatBytes(target.maxmemory)} maxmemory`;

  if (sourceBytes > free) {
    const volatile = target.policy.startsWith('volatile-');
    if (volatile || target.policy.startsWith('allkeys-')) {
      const oomNote = volatile
        ? ', and writes fail with OOM once no keys with a TTL are left to evict'
        : '';
      return [
        {
          severity: 'warning',
          category: 'capacity',
          title: 'Target will evict data during migration',
          detail: `The source dataset is about ${need}; the target has ${have}. With '${target.policy}' the target will evict about ${formatBytes(sourceBytes - free)} while it is being filled${oomNote}. Raise maxmemory or add shards before migrating.`,
        },
      ];
    }
    return [
      {
        severity: 'blocking',
        category: 'capacity',
        title: 'Target does not have enough memory',
        detail: `The source dataset is about ${need}; the target has ${have} (policy '${target.policy}'). Writes will fail with OOM part-way through the migration. Raise maxmemory, add shards, or free memory on the target first.`,
      },
    ];
  }

  if (sourceBytes > free * TIGHT_FIT_RATIO) {
    return [
      {
        severity: 'warning',
        category: 'capacity',
        title: 'Target memory is tight',
        detail: `The source dataset is about ${need}; the target has ${have}. That leaves under ${Math.round((1 - TIGHT_FIT_RATIO) * 100)}% headroom, and encoding or fragmentation differences between engines can use it up.`,
      },
    ];
  }
  return [];
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

export interface CapacityProbeInput {
  targetConfig: DatabaseConnectionConfig;
  targetIsCluster: boolean;
  /** Estimated source dataset size in bytes (0 when unknown). */
  sourceBytes: number;
  /** Source key names already sampled by analysis. */
  sampledKeys: string[];
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
      ...checkTargetCapacity(input.sourceBytes, target),
      ...checkKeyOverlap(target.keys, overlap),
    ];
  } finally {
    await client.quit().catch(() => undefined);
  }
}
