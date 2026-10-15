export const STRATUM_FLOOR = 30;

export interface AllocationInput {
  type: string;
  estimatedKeys: number;
  std: number;
  sampled: number;
}

export function splitBudget(budget: number, dbSizes: number[]): number[] {
  const total = dbSizes.reduce((sum, size) => sum + size, 0);
  if (total === 0) return dbSizes.map(() => 0);
  return dbSizes.map((size) => (size === 0 ? 0 : Math.max(1, Math.round((budget * size) / total))));
}

export function neymanAllocation(remaining: number, strata: AllocationInput[]): Map<string, number> {
  const weights = strata.map((stratum) => stratum.estimatedKeys * stratum.std);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const basis = weightSum > 0 ? weights : strata.map((stratum) => stratum.estimatedKeys);
  const basisSum = basis.reduce((sum, value) => sum + value, 0);
  const result = new Map<string, number>();
  strata.forEach((stratum, index) => {
    const share = basisSum > 0 ? Math.round((remaining * basis[index]) / basisSum) : 0;
    const floor = Math.min(STRATUM_FLOOR, stratum.estimatedKeys);
    const desired = Math.min(stratum.estimatedKeys, Math.max(stratum.sampled + share, floor));
    result.set(stratum.type, Math.max(0, Math.round(desired - stratum.sampled)));
  });
  return result;
}
