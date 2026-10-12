export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function adjustedSkewness(values: number[]): number {
  const n = values.length;
  const average = mean(values);
  const m2 = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, n);
  if (m2 === 0) return 0;
  if (n < 3) return Number.POSITIVE_INFINITY;
  const m3 = values.reduce((sum, value) => sum + (value - average) ** 3, 0) / n;
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * (m3 / m2 ** 1.5);
}

export function sampleVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}
