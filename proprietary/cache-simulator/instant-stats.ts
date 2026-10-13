import type { InfoResponse } from '@app/common/types/metrics.types';

export interface InstantStats {
  usedMemory: number;
  maxmemory: number;
  maxmemoryPolicy: string;
  datasetMemory: number | null;
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
    datasetMemory: info.memory?.used_memory_dataset === undefined ? null : toNumber(info.memory.used_memory_dataset),
  };
}
