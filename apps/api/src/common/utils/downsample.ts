/** Evenly-spaced series reduction to at most maxPoints, always keeping the last sample. */
export function downsampleSeries<T>(samples: T[], maxPoints: number): T[] {
  if (samples.length <= maxPoints) {
    return samples;
  }
  const step = samples.length / maxPoints;
  const sampled: T[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    sampled.push(samples[Math.floor(i * step)]);
  }
  sampled.push(samples[samples.length - 1]);
  return sampled;
}
