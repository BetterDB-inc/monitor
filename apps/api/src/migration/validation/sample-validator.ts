import Valkey, { Cluster } from 'iovalkey';
import type { SampleValidationResult, SampleKeyResult, SampleKeyStatus } from '@betterdb/shared';
import { describeStreamGroups } from '../execution/stream-metadata';

const TYPE_BATCH_SIZE = 100;
const MAX_ISSUES = 50;
const LARGE_KEY_THRESHOLD = 100;

/**
 * Spot-check a random sample of keys: type match + value comparison on target.
 * Never throws — per-key errors are captured as 'missing' with detail.
 *
 * A cluster source (a Cluster client, as createTargetClient() builds it) is
 * sampled on every master: SCAN is node-local, so sampling one node would only
 * ever check that shard's keys. The budget is split by each master's DBSIZE
 * (see splitSampleBudget), and each key is read from the master it was found on.
 */
export async function validateSample(
  sourceClient: Valkey,
  targetClient: Valkey,
  sampleSize: number = 500,
): Promise<SampleValidationResult> {
  // 1. Collect sample keys from source via SCAN with random starting cursor
  const groups = await collectSampleGroups(sourceClient, sampleSize);
  const keys: string[] = [];
  const owners: Valkey[] = [];
  for (const group of groups) {
    for (const key of group.keys) {
      keys.push(key);
      owners.push(group.node);
    }
  }

  if (keys.length === 0) {
    return { sampledKeys: 0, matched: 0, missing: 0, typeMismatches: 0, valueMismatches: 0, issues: [] };
  }

  // 2. Batch TYPE lookup on source (per node: a pipeline cannot span masters)
  const sourceTypes: string[] = [];
  for (const group of groups) {
    sourceTypes.push(...(await batchType(group.node, group.keys)));
  }

  // 3. Validate each key against target
  let matched = 0;
  let missing = 0;
  let typeMismatches = 0;
  let valueMismatches = 0;
  const issues: SampleKeyResult[] = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const sourceType = sourceTypes[i];

    if (sourceType === 'none') {
      // Key expired between SCAN and TYPE — skip, don't count toward any outcome
      continue;
    }

    try {
      const result = await validateKey(owners[i], targetClient, key, sourceType);

      switch (result.status) {
        case 'match':
          matched++;
          break;
        case 'missing':
          missing++;
          if (issues.length < MAX_ISSUES) issues.push(result);
          break;
        case 'type_mismatch':
          typeMismatches++;
          if (issues.length < MAX_ISSUES) issues.push(result);
          break;
        case 'value_mismatch':
          valueMismatches++;
          if (issues.length < MAX_ISSUES) issues.push(result);
          break;
      }
    } catch {
      // Risk mitigation: never throw — count as missing on error
      missing++;
      if (issues.length < MAX_ISSUES) {
        issues.push({ key, type: sourceType, status: 'missing', detail: 'error checking key' });
      }
    }
  }

  return {
    sampledKeys: matched + missing + typeMismatches + valueMismatches,
    matched,
    missing,
    typeMismatches,
    valueMismatches,
    issues,
  };
}

// ── Helpers ──

interface SampleGroup {
  node: Valkey;
  keys: string[];
}

async function collectSampleGroups(client: Valkey, sampleSize: number): Promise<SampleGroup[]> {
  // createTargetClient() casts Cluster to Valkey, so narrow from unknown.
  const maybeCluster: unknown = client;
  if (!(maybeCluster instanceof Cluster)) {
    return [{ node: client, keys: await collectSampleKeys(client, sampleSize) }];
  }
  const masters = maybeCluster.nodes('master');
  if (masters.length === 0) throw new Error('No cluster masters available to sample keys');
  const sizes = await Promise.all(masters.map((node) => node.dbsize()));
  const quotas = splitSampleBudget(sampleSize, sizes);
  return Promise.all(
    masters.map(async (node, index) => ({
      node,
      keys: quotas[index] > 0 ? await collectSampleKeys(node, quotas[index]) : [],
    })),
  );
}

/**
 * Split a sample budget across nodes in proportion to their key counts. Every
 * node that holds keys gets at least one sample while the budget allows, so a
 * small shard that never reached the target is still caught. Quotas never
 * exceed a node's key count and add up to min(total, sum of key counts).
 */
export function splitSampleBudget(total: number, sizes: number[]): number[] {
  const quotas = sizes.map(() => 0);
  const keyTotal = sizes.reduce((sum, size) => sum + Math.max(0, size), 0);
  let budget = Math.min(Math.max(0, Math.floor(total)), keyTotal);
  if (budget === 0) return quotas;

  const nonEmpty = sizes.filter((size) => size > 0).length;
  if (budget >= nonEmpty) {
    sizes.forEach((size, index) => {
      if (size > 0) quotas[index] = 1;
    });
    budget -= nonEmpty;
  }

  // Largest-remainder split of what is left, by the keys not yet counted.
  const remaining = sizes.map((size, index) => Math.max(0, size - quotas[index]));
  const remainingTotal = remaining.reduce((sum, size) => sum + size, 0);
  if (budget === 0 || remainingTotal === 0) return quotas;
  const shares = remaining.map((size) => (budget * size) / remainingTotal);
  let left = budget;
  shares.forEach((share, index) => {
    const whole = Math.floor(share);
    quotas[index] += whole;
    left -= whole;
  });
  const byRemainder = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { index } of byRemainder) {
    if (left === 0) break;
    if (quotas[index] < sizes[index]) {
      quotas[index] += 1;
      left -= 1;
    }
  }
  return quotas;
}

async function collectSampleKeys(client: Valkey, sampleSize: number): Promise<string[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  // Skip a random number of initial SCAN iterations to avoid always sampling the same keys
  const skipIterations = Math.floor(Math.random() * 10);
  let cursor = '0';
  let skipped = 0;

  do {
    const [nextCursor, batch] = await client.scan(cursor, 'COUNT', 100);
    cursor = nextCursor;

    if (skipped < skipIterations) {
      skipped++;
      if (cursor === '0') break; // keyspace smaller than skip window
      continue;
    }

    for (const key of batch) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
        if (keys.length >= sampleSize) return keys;
      }
    }
  } while (cursor !== '0');

  // If skipping caused us to collect fewer keys than needed, do a full pass
  if (keys.length < sampleSize && skipped > 0) {
    cursor = '0';
    do {
      const [nextCursor, batch] = await client.scan(cursor, 'COUNT', 100);
      cursor = nextCursor;
      for (const key of batch) {
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
          if (keys.length >= sampleSize) return keys;
        }
      }
    } while (cursor !== '0');
  }

  return keys;
}

async function batchType(client: Valkey, keys: string[]): Promise<string[]> {
  const results: string[] = [];

  for (let i = 0; i < keys.length; i += TYPE_BATCH_SIZE) {
    const batch = keys.slice(i, i + TYPE_BATCH_SIZE);
    const pipeline = client.pipeline();
    for (const key of batch) {
      pipeline.type(key);
    }
    const pipelineResults = await pipeline.exec();
    if (!pipelineResults) {
      for (let j = 0; j < batch.length; j++) results.push('none');
      continue;
    }
    for (const [err, val] of pipelineResults) {
      results.push(err ? 'none' : String(val));
    }
  }

  return results;
}

async function validateKey(
  source: Valkey,
  target: Valkey,
  key: string,
  sourceType: string,
): Promise<SampleKeyResult> {
  // Check target type
  const targetType = await target.type(key);

  if (targetType === 'none') {
    return { key, type: sourceType, status: 'missing' };
  }

  if (targetType !== sourceType) {
    return {
      key,
      type: sourceType,
      status: 'type_mismatch',
      detail: `source: ${sourceType}, target: ${targetType}`,
    };
  }

  // Types match — compare values based on type
  const mismatch = await compareValues(source, target, key, sourceType);
  if (mismatch) {
    return { key, type: sourceType, status: 'value_mismatch', detail: mismatch };
  }

  return { key, type: sourceType, status: 'match' };
}

async function compareValues(
  source: Valkey,
  target: Valkey,
  key: string,
  type: string,
): Promise<string | null> {
  switch (type) {
    case 'string':
      return compareString(source, target, key);
    case 'hash':
      return compareHash(source, target, key);
    case 'list':
      return compareList(source, target, key);
    case 'set':
      return compareSet(source, target, key);
    case 'zset':
      return compareZset(source, target, key);
    case 'stream':
      return compareStream(source, target, key);
    default:
      // Unknown type — types match, skip value comparison
      return null;
  }
}

async function compareString(source: Valkey, target: Valkey, key: string): Promise<string | null> {
  const [sourceVal, targetVal] = await Promise.all([
    source.getBuffer(key),
    target.getBuffer(key),
  ]);
  if (sourceVal === null && targetVal === null) return null;
  if (sourceVal === null || targetVal === null) return 'value is null on one side';
  if (!sourceVal.equals(targetVal)) return 'string value differs';
  return null;
}

async function compareHash(source: Valkey, target: Valkey, key: string): Promise<string | null> {
  const [sourceLen, targetLen] = await Promise.all([
    source.hlen(key),
    target.hlen(key),
  ]);

  if (sourceLen > LARGE_KEY_THRESHOLD || targetLen > LARGE_KEY_THRESHOLD) {
    // Risk #3: Large key — count-only comparison
    if (Math.abs(sourceLen - targetLen) / Math.max(sourceLen, 1) > 0.05) {
      return `field count differs (source: ${sourceLen}, target: ${targetLen}). Large key — value comparison skipped (compared element count only).`;
    }
    return null;
  }

  // Use HSCAN to preserve binary field names as raw Buffers
  // (hgetallBuffer returns Record<string, Buffer> which coerces field names to UTF-8 strings)
  const sourceEntries = await scanAllHashFields(source, key);
  const targetEntries = await scanAllHashFields(target, key);

  if (sourceEntries.length !== targetEntries.length) {
    return `field count differs (source: ${sourceEntries.length}, target: ${targetEntries.length})`;
  }

  // Sort by field name bytes for deterministic comparison
  sourceEntries.sort((a, b) => a.field.compare(b.field));
  targetEntries.sort((a, b) => a.field.compare(b.field));

  // Compare all sorted fields (fully binary-safe)
  for (let i = 0; i < sourceEntries.length; i++) {
    if (!sourceEntries[i].field.equals(targetEntries[i].field)) {
      return `field names differ at index ${i}`;
    }
    if (!sourceEntries[i].value.equals(targetEntries[i].value)) {
      return `field "${sourceEntries[i].field.toString()}" value differs`;
    }
  }

  return null;
}

async function compareList(source: Valkey, target: Valkey, key: string): Promise<string | null> {
  const [sourceLen, targetLen] = await Promise.all([
    source.llen(key),
    target.llen(key),
  ]);

  if (sourceLen > LARGE_KEY_THRESHOLD || targetLen > LARGE_KEY_THRESHOLD) {
    if (sourceLen !== targetLen) {
      return `list length differs (source: ${sourceLen}, target: ${targetLen}). Large key — value comparison skipped (compared element count only).`;
    }
    return null;
  }

  const [sourceItems, targetItems] = await Promise.all([
    source.lrangeBuffer(key, 0, -1),
    target.lrangeBuffer(key, 0, -1),
  ]);

  if (sourceItems.length !== targetItems.length) {
    return `list length differs (source: ${sourceItems.length}, target: ${targetItems.length})`;
  }

  for (let i = 0; i < sourceItems.length; i++) {
    if (!sourceItems[i].equals(targetItems[i])) {
      return `list element differs at index ${i}`;
    }
  }

  return null;
}

async function compareSet(source: Valkey, target: Valkey, key: string): Promise<string | null> {
  const [sourceCard, targetCard] = await Promise.all([
    source.scard(key),
    target.scard(key),
  ]);

  if (sourceCard > LARGE_KEY_THRESHOLD || targetCard > LARGE_KEY_THRESHOLD) {
    if (sourceCard !== targetCard) {
      return `set cardinality differs (source: ${sourceCard}, target: ${targetCard}). Large key — value comparison skipped (compared element count only).`;
    }
    return null;
  }

  const [sourceMembers, targetMembers] = await Promise.all([
    source.smembersBuffer(key),
    target.smembersBuffer(key),
  ]);

  if (sourceMembers.length !== targetMembers.length) {
    return `set cardinality differs (source: ${sourceMembers.length}, target: ${targetMembers.length})`;
  }

  // Sort by raw bytes for deterministic comparison
  sourceMembers.sort((a, b) => a.compare(b));
  targetMembers.sort((a, b) => a.compare(b));

  for (let i = 0; i < sourceMembers.length; i++) {
    if (!sourceMembers[i].equals(targetMembers[i])) {
      return 'set members differ';
    }
  }

  return null;
}

async function compareZset(source: Valkey, target: Valkey, key: string): Promise<string | null> {
  const [sourceCard, targetCard] = await Promise.all([
    source.zcard(key),
    target.zcard(key),
  ]);

  if (sourceCard > LARGE_KEY_THRESHOLD || targetCard > LARGE_KEY_THRESHOLD) {
    if (sourceCard !== targetCard) {
      return `zset cardinality differs (source: ${sourceCard}, target: ${targetCard}). Large key — value comparison skipped (compared element count only).`;
    }
    return null;
  }

  const [sourceData, targetData] = await Promise.all([
    source.callBuffer('ZRANGE', key, '0', '-1', 'WITHSCORES') as Promise<Buffer[]>,
    target.callBuffer('ZRANGE', key, '0', '-1', 'WITHSCORES') as Promise<Buffer[]>,
  ]);

  if (!sourceData && !targetData) return null;
  if (!sourceData || !targetData) return 'zset data missing on one side';
  if (sourceData.length !== targetData.length) {
    return `zset element count differs (source: ${sourceData.length / 2}, target: ${targetData.length / 2})`;
  }

  for (let i = 0; i < sourceData.length; i++) {
    if (!sourceData[i].equals(targetData[i])) {
      return 'zset member or score differs';
    }
  }

  return null;
}

async function scanAllHashFields(client: Valkey, key: string): Promise<Array<{ field: Buffer; value: Buffer }>> {
  const entries: Array<{ field: Buffer; value: Buffer }> = [];
  let cursor = '0';
  do {
    const [next, fields] = await client.hscanBuffer(key, cursor, 'COUNT', 100);
    cursor = String(next);
    for (let i = 0; i < fields.length; i += 2) {
      entries.push({ field: fields[i], value: fields[i + 1] });
    }
  } while (cursor !== '0');
  return entries;
}

async function compareStream(source: Valkey, target: Valkey, key: string): Promise<string | null> {
  const [sourceLen, targetLen] = await Promise.all([
    source.xlen(key),
    target.xlen(key),
  ]);

  if (sourceLen !== targetLen) {
    return `stream length differs (source: ${sourceLen}, target: ${targetLen})`;
  }

  // Equal length is not enough: a stream migrated without its consumer groups
  // looks identical to XLEN but breaks every XREADGROUP after cutover.
  const [sourceGroups, targetGroups] = await Promise.all([
    describeStreamGroups(source, key),
    describeStreamGroups(target, key),
  ]);
  if (sourceGroups !== targetGroups) {
    return `consumer groups differ (source: ${sourceGroups || 'none'}, target: ${targetGroups || 'none'})`;
  }

  return null;
}
