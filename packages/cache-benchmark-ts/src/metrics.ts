import type { ReplayResult, Metrics } from './types.js';

export function computeMetrics(results: ReplayResult[]): Metrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const latencies: number[] = [];
  let similaritySum = 0;
  let hitCount = 0;

  for (const r of results) {
    latencies.push(r.latencyMs);
    if (r.hit && r.isSemanticMatch) tp++;
    else if (r.hit && !r.isSemanticMatch) fp++;
    else if (!r.hit && !r.isSemanticMatch) tn++;
    else fn++;

    if (r.hit && r.similarityScore != null) {
      similaritySum += r.similarityScore;
      hitCount++;
    }
  }

  const total = results.length;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);

  latencies.sort((a, b) => a - b);

  return {
    total,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    hitRate: total === 0 ? 0 : (tp + fp) / total,
    precision,
    recall,
    f1,
    falsePositiveRate: fpr,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    p99LatencyMs: percentile(latencies, 0.99),
    meanSimilarityOnHits: hitCount === 0 ? 0 : similaritySum / hitCount,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
