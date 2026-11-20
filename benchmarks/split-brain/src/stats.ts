import { mulberry32 } from './config';

export interface Interval {
  mean: number;
  low: number;
  high: number;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function wilson(successes: number, trials: number, z = 1.96): { low: number; high: number } {
  if (trials === 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return {
    low: successes === 0 ? 0 : Math.max(0, (centre - margin) / denominator),
    high: successes === trials ? 1 : Math.min(1, (centre + margin) / denominator),
  };
}

export function bootstrapMean(values: number[], resamples = 10_000, seed = 697): Interval {
  const centre = mean(values);
  if (values.length === 0) return { mean: 0, low: 0, high: 0 };
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: centre,
    low: means[Math.floor(0.025 * resamples)],
    high: means[Math.min(resamples - 1, Math.floor(0.975 * resamples))],
  };
}

export function rateInterval(shares: number[]): Interval {
  const trials = shares.length;
  if (trials === 0) return { mean: 0, low: 0, high: 1 };
  const boot = bootstrapMean(shares);
  const hits = shares.filter((share) => share > 0);
  const misses = shares.filter((share) => share < 1).map((share) => 1 - share);
  const high = Math.max(boot.high, wilson(hits.length, trials).high * mean(hits));
  const low = Math.min(boot.low, 1 - wilson(misses.length, trials).high * mean(misses));
  return {
    mean: boot.mean,
    low: misses.length === 0 ? wilson(trials, trials).low : Math.max(0, low),
    high: hits.length === 0 ? wilson(0, trials).high : Math.min(1, high),
  };
}

export function countInterval(successes: number, trials: number): Interval {
  return { mean: trials === 0 ? 0 : successes / trials, ...wilson(successes, trials) };
}

export function medianInterval(values: number[], resamples = 10_000, seed = 697): Interval {
  if (values.length === 0) return { mean: 0, low: 0, high: 0 };
  const random = mulberry32(seed);
  const medians: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const sample: number[] = [];
    for (let j = 0; j < values.length; j++) sample.push(values[Math.floor(random() * values.length)]);
    medians.push(quantile(sample, 0.5));
  }
  medians.sort((a, b) => a - b);
  return {
    mean: quantile(values, 0.5),
    low: medians[Math.floor(0.025 * resamples)],
    high: medians[Math.min(resamples - 1, Math.floor(0.975 * resamples))],
  };
}

export interface PairedDifference extends Interval {
  identical: boolean;
  tie: boolean;
}

export function pairedDifference(a: number[], b: number[]): PairedDifference {
  const differences = a.map((value, index) => value - b[index]);
  const identical = differences.every((difference) => difference === 0);
  const interval = identical ? { mean: 0, low: 0, high: 0 } : bootstrapMean(differences);
  return { ...interval, identical, tie: interval.low <= 0 && interval.high >= 0 };
}
