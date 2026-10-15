import type { InfoResponse } from '@app/common/types/metrics.types';

export interface InstantStats {
  usedMemory: number;
  maxmemory: number;
  maxmemoryPolicy: string;
  datasetMemory: number | null;
}

function toFinite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value: unknown): number {
  return toFinite(value) ?? 0;
}

export function readInstantStats(info: InfoResponse): InstantStats {
  const policy = info.memory?.maxmemory_policy;
  const usedMemory = toNumber(info.memory?.used_memory);
  const dataset = toFinite(info.memory?.used_memory_dataset);
  return {
    usedMemory,
    maxmemory: toNumber(info.memory?.maxmemory),
    maxmemoryPolicy: policy ? policy : 'unknown',
    datasetMemory: dataset !== null && dataset > usedMemory ? null : dataset,
  };
}
