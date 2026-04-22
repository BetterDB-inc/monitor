export interface PercentileTriple {
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

export function computePercentiles(durations: readonly number[]): PercentileTriple {
  const count = durations.length;
  if (count === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    count,
  };
}

function nearestRank(sorted: readonly number[], p: number): number {
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}
