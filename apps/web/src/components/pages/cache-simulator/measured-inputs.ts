import { DEFAULT_OVERHEAD_PER_KEY_BYTES, fixedOverhead, type CacheSimulatorSnapshot, type ProjectionInputs } from '@betterdb/shared';

export interface SimulatorInputs {
  keysPerDay: number;
  ttlDays: number | null;
  avgKeyBytes: number;
  overheadPerKeyBytes: number;
  maxmemory: number;
}

export const HORIZONS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6m', days: 182 },
];

export function measuredInputs(snapshot: CacheSimulatorSnapshot): SimulatorInputs {
  const { instant, estimate, growth } = snapshot;
  const infoAverage = instant.totalKeys > 0 ? instant.usedMemory / instant.totalKeys - DEFAULT_OVERHEAD_PER_KEY_BYTES : 0;
  return {
    keysPerDay: growth?.keysPerDay ?? 0,
    ttlDays: null,
    avgKeyBytes: Math.max(0, estimate?.avgKeyBytes ?? infoAverage),
    overheadPerKeyBytes: DEFAULT_OVERHEAD_PER_KEY_BYTES,
    maxmemory: instant.maxmemory,
  };
}

export function projectionInputs(snapshot: CacheSimulatorSnapshot, inputs: SimulatorInputs, horizonDays: number): ProjectionInputs {
  const keys = snapshot.instant.totalKeys;
  return {
    currentKeys: keys,
    keysPerDay: inputs.keysPerDay,
    ttlDays: inputs.ttlDays,
    avgKeyBytes: inputs.avgKeyBytes,
    stdKeyBytes: snapshot.estimate?.stdKeyBytes ?? 0,
    sampleCount: snapshot.estimate?.sampleCount ?? 0,
    overheadPerKeyBytes: inputs.overheadPerKeyBytes,
    fixedOverheadBytes: fixedOverhead(snapshot.instant.usedMemory, keys, inputs.avgKeyBytes, inputs.overheadPerKeyBytes),
    maxmemory: inputs.maxmemory > 0 ? inputs.maxmemory : null,
    horizonDays,
  };
}
