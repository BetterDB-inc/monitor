import { MetricType, MetricSample, BufferStats } from './types';

export class MetricBuffer {
  private samples: MetricSample[] = [];
  private readonly maxSamples: number;
  private readonly minSamples: number;

  constructor(
    private readonly metricType: MetricType,
    maxSamples: number = 300, // 5 minutes at 1s interval
    minSamples: number = 30,  // 30 seconds minimum
  ) {
    this.maxSamples = maxSamples;
    this.minSamples = minSamples;
  }

  addSample(value: number, timestamp: number = Date.now()): void {
    this.samples.push({ timestamp, value });

    // Keep only the last maxSamples
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  isReady(): boolean {
    return this.samples.length >= this.minSamples;
  }

  getMean(): number {
    if (this.samples.length === 0) return 0;
    const sum = this.samples.reduce((acc, sample) => acc + sample.value, 0);
    return sum / this.samples.length;
  }

  getStdDev(): number {
    if (this.samples.length < 2) return 0;

    const mean = this.getMean();
    const squaredDiffs = this.samples.map(sample => Math.pow(sample.value - mean, 2));
    const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / this.samples.length;
    return Math.sqrt(variance);
  }

  getZScore(value: number): number {
    const mean = this.getMean();
    const stdDev = this.getStdDev();

    if (stdDev === 0) return 0;
    return (value - mean) / stdDev;
  }

  getLatest(): number | null {
    if (this.samples.length === 0) return null;
    return this.samples[this.samples.length - 1].value;
  }

  getMin(): number {
    if (this.samples.length === 0) return 0;
    return Math.min(...this.samples.map(s => s.value));
  }

  getMax(): number {
    if (this.samples.length === 0) return 0;
    return Math.max(...this.samples.map(s => s.value));
  }

  getStats(): BufferStats {
    const latest = this.getLatest();
    return {
      metricType: this.metricType,
      sampleCount: this.samples.length,
      mean: this.getMean(),
      stdDev: this.getStdDev(),
      min: this.getMin(),
      max: this.getMax(),
      latest: latest !== null ? latest : 0,
      isReady: this.isReady(),
    };
  }

  getSampleCount(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples = [];
  }
}
