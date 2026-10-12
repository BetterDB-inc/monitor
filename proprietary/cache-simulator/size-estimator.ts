import type { CacheSimulatorEstimate, CacheSimulatorTypeEstimate } from '@betterdb/shared';
import { mean, sampleVariance } from './sample-stats';
import type { NodeSample } from './sample-types';

const Z95 = 1.96;

interface TypeTotals {
  keys: number;
  weighted: number;
  second: number;
  sampled: number;
}

export function estimate(nodes: NodeSample[], sampledAt: number): CacheSimulatorEstimate {
  const cells = nodes.flatMap((node) => node.strata.filter((stratum) => stratum.estimatedKeys > 0));
  const pooled = cells.flatMap((cell) => cell.sizes);
  const pooledMean = mean(pooled);
  const pooledVariance = sampleVariance(pooled);
  const types = new Map<string, TypeTotals>();
  let total = 0;
  let variance = 0;

  for (const cell of cells) {
    const n = cell.sizes.length;
    const N = cell.estimatedKeys;
    const cellMean = n > 0 ? mean(cell.sizes) : pooledMean;
    const cellVariance = n > 0 ? sampleVariance(cell.sizes) : pooledVariance;
    total += N * cellMean;
    variance += n === 0 ? N * N * pooledVariance : ((N * N) / n) * cellVariance * Math.max(0, 1 - n / N);
    const totals = types.get(cell.type) ?? { keys: 0, weighted: 0, second: 0, sampled: 0 };
    totals.keys += N;
    totals.weighted += N * cellMean;
    totals.second += N * (cellVariance + cellMean * cellMean);
    totals.sampled += n;
    types.set(cell.type, totals);
  }

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

  const keys = byType.reduce((sum, entry) => sum + entry.keys, 0);
  const second = [...types.values()].reduce((sum, entry) => sum + entry.second, 0);
  const avgKeyBytes = keys > 0 ? total / keys : 0;
  return {
    totalBytes: total,
    ci95Bytes: Z95 * Math.sqrt(variance),
    avgKeyBytes,
    stdKeyBytes: keys > 0 ? Math.sqrt(Math.max(0, second / keys - avgKeyBytes * avgKeyBytes)) : 0,
    sampleCount: byType.reduce((sum, entry) => sum + entry.sampled, 0),
    byType,
    sampledAt,
    partial: nodes.some((node) => node.timedOut),
  };
}
