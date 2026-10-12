export const DEFAULT_OVERHEAD_PER_KEY_BYTES = 88;
export const HEADROOM = 0.8;
const Z95 = 1.96;

export interface ProjectionInputs {
  currentKeys: number;
  keysPerDay: number;
  ttlDays: number | null;
  avgKeyBytes: number;
  stdKeyBytes: number;
  sampleCount: number;
  overheadPerKeyBytes: number;
  fixedOverheadBytes: number;
  maxmemory: number | null;
  horizonDays: number;
}

export interface ProjectionPoint {
  day: number;
  keys: number;
  bytes: number;
  low: number;
  high: number;
}

export interface Projection {
  points: ProjectionPoint[];
  daysToMaxmemory: number | null;
  daysTo80Percent: number | null;
}

export function fixedOverhead(usedMemory: number, keys: number, avgKeyBytes: number, overheadPerKeyBytes: number): number {
  return Math.max(0, usedMemory - keys * (avgKeyBytes + overheadPerKeyBytes));
}

export function keysAt(day: number, inputs: Pick<ProjectionInputs, 'currentKeys' | 'keysPerDay' | 'ttlDays'>): number {
  const { currentKeys, keysPerDay, ttlDays } = inputs;
  if (ttlDays !== null && ttlDays > 0) {
    const steady = Math.max(0, keysPerDay * ttlDays);
    return Math.max(0, steady + (currentKeys - steady) * Math.exp(-day / ttlDays));
  }
  return Math.max(0, currentKeys + keysPerDay * day);
}

function firstDayAtOrAbove(points: ProjectionPoint[], limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return points.find((point) => point.bytes >= limit)?.day ?? null;
}

export function project(inputs: ProjectionInputs): Projection {
  const perKey = inputs.avgKeyBytes + inputs.overheadPerKeyBytes;
  const margin = inputs.sampleCount > 0 ? (Z95 * inputs.stdKeyBytes) / Math.sqrt(inputs.sampleCount) : 0;
  const points: ProjectionPoint[] = [];
  for (let day = 0; day <= inputs.horizonDays; day++) {
    const keys = keysAt(day, inputs);
    const bytes = keys * perKey + inputs.fixedOverheadBytes;
    points.push({ day, keys, bytes, low: Math.max(0, bytes - margin * keys), high: bytes + margin * keys });
  }
  const limit = inputs.maxmemory && inputs.maxmemory > 0 ? inputs.maxmemory : null;
  return {
    points,
    daysToMaxmemory: firstDayAtOrAbove(points, limit),
    daysTo80Percent: firstDayAtOrAbove(points, limit === null ? null : limit * HEADROOM),
  };
}
