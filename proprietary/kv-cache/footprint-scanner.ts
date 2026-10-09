import type { DatabasePort } from '@app/common/interfaces/database-port.interface';
import type { InfoResponse } from '@app/common/types/metrics.types';
import { classifyKey, LMCACHE_SCAN_PATTERN, siblingKey } from './key-classifier';
import type { KeySample, MemoryStats } from './footprint-estimate';

export interface ScanBudgets {
  maxScanned: number;
  maxMatched: number;
}

export interface ScanResult {
  scannedKeys: number;
  matchedKeys: string[];
  scanComplete: boolean;
}

const SCAN_COUNT = 1000;
const GLIDE_LMCACHE = /lib-name=GlidePySync\(lmcache:/;

export async function scanLmcacheKeys(client: DatabasePort, budgets: ScanBudgets, dbSize: number): Promise<ScanResult> {
  let cursor = '0';
  let iterations = 0;
  const matched: string[] = [];
  do {
    const [next, keys] = (await client.call('SCAN', [cursor, 'MATCH', LMCACHE_SCAN_PATTERN, 'COUNT', String(SCAN_COUNT)])) as [string, string[]];
    cursor = String(next);
    iterations += 1;
    for (const key of keys) {
      if (classifyKey(key)) matched.push(key);
    }
  } while (cursor !== '0' && iterations * SCAN_COUNT < budgets.maxScanned && matched.length < budgets.maxMatched);
  const walked = cursor === '0' ? dbSize : Math.min(iterations * SCAN_COUNT, dbSize);
  const kept = matched.slice(0, budgets.maxMatched);
  const scannedKeys = kept.length < matched.length ? Math.max(1, Math.floor((walked * kept.length) / matched.length)) : walked;
  return {
    scannedKeys,
    matchedKeys: kept,
    scanComplete: cursor === '0' && matched.length <= budgets.maxMatched,
  };
}

export async function sampleLmcacheKeys(client: DatabasePort, keys: string[]): Promise<KeySample[]> {
  if (keys.length === 0) return [];
  const pipeline = client.getClient().pipeline();
  const plan = keys.map((key) => {
    const parsed = classifyKey(key)!;
    const sibling = siblingKey(key, parsed);
    pipeline.call('MEMORY', 'USAGE', key);
    pipeline.ttl(key);
    if (sibling) pipeline.exists(sibling);
    return { key, parsed, sibling };
  });
  const replies = ((await pipeline.exec()) ?? []) as Array<[Error | null, unknown]>;
  let index = 0;
  return plan.map(({ key, parsed, sibling }) => {
    const [memoryErr, memory] = replies[index++] ?? [new Error('missing'), null];
    const [ttlErr, ttl] = replies[index++] ?? [new Error('missing'), null];
    let siblingExists: boolean | null = null;
    if (sibling) {
      const [existsErr, exists] = replies[index++] ?? [new Error('missing'), null];
      siblingExists = !existsErr && Number(exists) === 1;
    }
    return {
      key,
      parsed,
      memoryBytes: memoryErr || memory === null ? null : Number(memory),
      ttl: ttlErr ? -2 : Number(ttl),
      siblingExists,
    };
  });
}

export async function hasLmcacheGlideClient(client: DatabasePort): Promise<boolean> {
  try {
    return GLIDE_LMCACHE.test(String(await client.call('CLIENT', ['LIST'])));
  } catch {
    return false;
  }
}

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function readMemoryStats(info: InfoResponse): MemoryStats {
  return {
    usedMemory: num(info.memory?.used_memory),
    maxmemory: num(info.memory?.maxmemory),
    maxmemoryPolicy: info.memory?.maxmemory_policy ?? 'unknown',
    evictedKeys: num(info.stats?.evicted_keys),
  };
}

export function otherNonEmptyDbs(info: InfoResponse, ownDb: number): number[] {
  return Object.entries(info.keyspace ?? {})
    .map(([name, value]) => ({ db: /^db(\d+)$/.exec(name)?.[1], value }))
    .filter(({ db, value }) => db !== undefined && typeof value === 'object' && value.keys > 0)
    .map(({ db }) => Number(db))
    .filter((db) => db !== ownDb)
    .sort((a, b) => a - b);
}
