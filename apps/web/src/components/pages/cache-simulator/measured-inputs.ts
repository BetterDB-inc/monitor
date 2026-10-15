import { DEFAULT_OVERHEAD_PER_KEY_BYTES, fixedOverhead, inPlaceGrowth, type CacheSimulatorSnapshot, type ProjectionInputs } from '@betterdb/shared';

export interface SimulatorInputs {
  keysPerDay: number;
  inPlaceBytesPerDay: number;
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

export function isSetupFailure(snapshot: CacheSimulatorSnapshot): boolean {
  return snapshot.status === 'failed' && snapshot.estimate === null && snapshot.instant.totalKeys === 0 && snapshot.instant.usedMemory === 0;
}

export function keepPreviousEstimate(previous: CacheSimulatorSnapshot | undefined, next: CacheSimulatorSnapshot): CacheSimulatorSnapshot {
  return next.status === 'sampling' && next.estimate === null && previous?.estimate ? { ...next, estimate: previous.estimate } : next;
}

export function measuredInputs(snapshot: CacheSimulatorSnapshot): SimulatorInputs {
  const { instant, estimate, growth } = snapshot;
  const infoAverage = instant.totalKeys > 0 ? instant.usedMemory / instant.totalKeys - DEFAULT_OVERHEAD_PER_KEY_BYTES : 0;
  const avgKeyBytes = Math.max(0, Math.round(estimate?.avgKeyBytes ?? infoAverage));
  const overheadPerKeyBytes = estimate ? 0 : DEFAULT_OVERHEAD_PER_KEY_BYTES;
  return {
    keysPerDay: growth?.keysPerDay ?? 0,
    inPlaceBytesPerDay: growth ? Math.round(inPlaceGrowth(growth, avgKeyBytes + overheadPerKeyBytes)) : 0,
    ttlDays: null,
    avgKeyBytes,
    overheadPerKeyBytes,
    maxmemory: instant.maxmemory,
  };
}

export function projectionInputs(snapshot: CacheSimulatorSnapshot, inputs: SimulatorInputs, horizonDays: number): ProjectionInputs {
  const keys = snapshot.instant.totalKeys;
  return {
    currentKeys: keys,
    keysPerDay: inputs.keysPerDay,
    inPlaceBytesPerDay: inputs.inPlaceBytesPerDay,
    ttlDays: inputs.ttlDays,
    avgKeyBytes: inputs.avgKeyBytes,
    ci95Bytes: snapshot.estimate?.ci95Bytes ?? 0,
    overheadPerKeyBytes: inputs.overheadPerKeyBytes,
    fixedOverheadBytes: fixedOverhead(snapshot.instant.usedMemory, keys, inputs.avgKeyBytes, inputs.overheadPerKeyBytes),
    maxmemory: inputs.maxmemory > 0 ? inputs.maxmemory : null,
    horizonDays,
  };
}

export function steadyBytes(inputs: ProjectionInputs): number | null {
  if (inputs.ttlDays === null || inputs.ttlDays <= 0 || inputs.inPlaceBytesPerDay > 0) return null;
  return Math.max(0, inputs.keysPerDay * inputs.ttlDays) * (inputs.avgKeyBytes + inputs.overheadPerKeyBytes) + inputs.fixedOverheadBytes;
}
