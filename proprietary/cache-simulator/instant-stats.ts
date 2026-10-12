import type { InfoResponse } from '@app/common/types/metrics.types';

export interface InstantStats {
  usedMemory: number;
  maxmemory: number;
  maxmemoryPolicy: string;
  evictedKeys: number;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function readInstantStats(info: InfoResponse): InstantStats {
  const policy = info.memory?.maxmemory_policy;
  return {
    usedMemory: toNumber(info.memory?.used_memory),
    maxmemory: toNumber(info.memory?.maxmemory),
    maxmemoryPolicy: policy ? policy : 'unknown',
    evictedKeys: toNumber(info.stats?.evicted_keys),
  };
}
