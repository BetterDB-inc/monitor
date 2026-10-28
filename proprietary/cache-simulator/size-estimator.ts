import type { CacheSimulatorEstimate, CacheSimulatorTypeEstimate } from '@betterdb/shared';
import { isHeavyTailed, mean, sampleVariance } from './sample-stats';
import type { NodeSample } from './sample-types';

const Z95 = 1.96;
export const DICT_ENTRY_BYTES = 24;
export const MISSED_GAP_SHARE = 0.15;

export function keyMemoryCeiling(datasetBytes: number, keys: number): number {
  return datasetBytes + keys * DICT_ENTRY_BYTES;
}

interface TypeTotals {
  keys: number;
  weighted: number;
  second: number;
  sampled: number;
}

function countVariance(strata: NodeSample['strata'], pooledMean: number): number {
  const open = strata.filter((stratum) => !stratum.exact && stratum.estimatedKeys > 0);
  const observed = open.reduce((sum, stratum) => sum + stratum.observed, 0);
  const keys = open.reduce((sum, stratum) => sum + stratum.estimatedKeys, 0);
  if (open.length < 2 || observed <= 0 || keys <= observed) return 0;
  const means = open.map((stratum) => (stratum.sizes.length > 0 ? mean(stratum.sizes) : pooledMean));
  const weights = open.map((stratum) => stratum.observed / observed);
  const center = weights.reduce((sum, weight, index) => sum + weight * means[index], 0);
  const spread = weights.reduce((sum, weight, index) => sum + weight * (means[index] - center) ** 2, 0);
  return ((keys * keys) / observed) * spread * (1 - observed / keys);
}

export function estimate(nodes: NodeSample[], sampledAt: number, memoryCeiling?: number): CacheSimulatorEstimate {
  const cells = nodes.flatMap((node) => node.strata.filter((stratum) => stratum.estimatedKeys > 0));
  const pooled = cells.flatMap((cell) => cell.sizes);
  const pooledMean = mean(pooled);
  const pooledVariance = sampleVariance(pooled);
  const types = new Map<string, TypeTotals>();
  let total = 0;
  let variance = nodes.reduce((sum, node) => sum + countVariance(node.strata, pooledMean), 0);

  for (const cell of cells) {
    const n = cell.sizes.length;
    const N = cell.estimatedKeys;
    const cellMean = n > 0 ? mean(cell.sizes) : pooledMean;
    const cellVariance = n < 2 && N > n ? pooledVariance : sampleVariance(cell.sizes);
    total += N * cellMean;
    variance += n === 0 ? N * N * pooledVariance : ((N * N) / n) * cellVariance * Math.max(0, 1 - n / N);
    const totals = types.get(cell.type) ?? { keys: 0, weighted: 0, second: 0, sampled: 0 };
    totals.keys += N;
    totals.weighted += N * cellMean;
    totals.second += N * (cellVariance + cellMean * cellMean);
    totals.sampled += n;
    types.set(cell.type, totals);
  }

  const tailAllowance = cells
    .filter(isHeavyTailed)
    .reduce((sum, cell) => sum + cell.estimatedKeys * (3 / cell.sizes.length) * cell.sizes.reduce((largest, size) => Math.max(largest, size), 0), 0);

  const byType: CacheSimulatorTypeEstimate[] = [...types].map(([type, totals]) => {
    const avgBytes = totals.weighted / totals.keys;
    return {
      type,
      keys: totals.keys,
      avgBytes,
      stdBytes: Math.sqrt(Math.max(0, totals.second / totals.keys - avgBytes * avgBytes)),
      sampled: totals.sampled,
    };
  });
  byType.sort((a, b) => b.keys * b.avgBytes - a.keys * a.avgBytes);

  const statistical = Z95 * Math.sqrt(variance) + tailAllowance;
  const unsampled =
    cells.some((cell) => cell.sizes.length < cell.estimatedKeys) ||
    nodes.some((node) => node.strata.reduce((sum, stratum) => sum + stratum.sizes.length, 0) < node.dbSize);
  const unexplained = memoryCeiling !== undefined && unsampled ? Math.abs(memoryCeiling - total) : 0;
  const likelyMissedLargeKeys =
    memoryCeiling !== undefined &&
    unsampled &&
    memoryCeiling - total > Math.max(statistical, MISSED_GAP_SHARE * memoryCeiling);
  const keys = byType.reduce((sum, entry) => sum + entry.keys, 0);
  const second = [...types.values()].reduce((sum, entry) => sum + entry.second, 0);
  const avgKeyBytes = keys > 0 ? total / keys : 0;
  return {
    totalBytes: total,
    ci95Bytes: Math.max(statistical, unexplained),
    avgKeyBytes,
    stdKeyBytes: keys > 0 ? Math.sqrt(Math.max(0, second / keys - avgKeyBytes * avgKeyBytes)) : 0,
    sampleCount: byType.reduce((sum, entry) => sum + entry.sampled, 0),
    byType,
    sampledAt,
    partial: nodes.some((node) => node.timedOut),
    likelyMissedLargeKeys,
  };
}
