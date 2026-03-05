import { MetricBuffer } from '../metric-buffer';
import { MetricType } from '../types';

describe('MetricBuffer', () => {
  let buffer: MetricBuffer;

  beforeEach(() => {
    buffer = new MetricBuffer(MetricType.CONNECTIONS, 10, 3);
  });

  describe('addSample & getSampleCount', () => {
    it('stores samples and reports count', () => {
      buffer.addSample(1, 100);
      buffer.addSample(2, 200);
      expect(buffer.getSampleCount()).toBe(2);
    });

    it('evicts oldest sample when exceeding maxSamples', () => {
      for (let i = 0; i < 12; i++) {
        buffer.addSample(i, i * 100);
      }
      expect(buffer.getSampleCount()).toBe(10);
      // Oldest (0, 1) evicted → latest should be 11, min should be 2
      expect(buffer.getLatest()).toBe(11);
      expect(buffer.getMin()).toBe(2);
    });
  });

  describe('isReady', () => {
    it('returns false before reaching minSamples', () => {
      buffer.addSample(1, 100);
      buffer.addSample(2, 200);
      expect(buffer.isReady()).toBe(false);
    });

    it('returns true once minSamples reached', () => {
      for (let i = 0; i < 3; i++) buffer.addSample(i, i * 100);
      expect(buffer.isReady()).toBe(true);
    });
  });

  describe('getMean', () => {
    it('returns 0 for empty buffer', () => {
      expect(buffer.getMean()).toBe(0);
    });

    it('computes arithmetic mean', () => {
      buffer.addSample(10, 1);
      buffer.addSample(20, 2);
      buffer.addSample(30, 3);
      expect(buffer.getMean()).toBe(20);
    });
  });

  describe('getStdDev', () => {
    it('returns 0 for fewer than 2 samples', () => {
      expect(buffer.getStdDev()).toBe(0);
      buffer.addSample(5, 1);
      expect(buffer.getStdDev()).toBe(0);
    });

    it('computes population standard deviation', () => {
      // values: 2, 4, 4, 4, 5, 5, 7, 9 → mean=5, variance=4, stdDev=2
      const vals = [2, 4, 4, 4, 5, 5, 7, 9];
      const b = new MetricBuffer(MetricType.MEMORY_USED, 100, 1);
      vals.forEach((v, i) => b.addSample(v, i));
      expect(b.getStdDev()).toBeCloseTo(2, 5);
    });
  });

  describe('getZScore', () => {
    it('returns 0 when stdDev is 0 (constant values)', () => {
      for (let i = 0; i < 5; i++) buffer.addSample(10, i);
      expect(buffer.getZScore(10)).toBe(0);
      expect(buffer.getZScore(20)).toBe(0); // stdDev=0 → always 0
    });

    it('computes correct z-score', () => {
      // mean=5, stdDev=2 (from dataset above)
      const vals = [2, 4, 4, 4, 5, 5, 7, 9];
      const b = new MetricBuffer(MetricType.MEMORY_USED, 100, 1);
      vals.forEach((v, i) => b.addSample(v, i));
      // z = (11 - 5) / 2 = 3
      expect(b.getZScore(11)).toBeCloseTo(3, 5);
    });
  });

  describe('getLatest', () => {
    it('returns null for empty buffer', () => {
      expect(buffer.getLatest()).toBeNull();
    });

    it('returns the most recently added value', () => {
      buffer.addSample(1, 100);
      buffer.addSample(42, 200);
      expect(buffer.getLatest()).toBe(42);
    });
  });

  describe('getMin / getMax', () => {
    it('returns 0 for empty buffer', () => {
      expect(buffer.getMin()).toBe(0);
      expect(buffer.getMax()).toBe(0);
    });

    it('returns correct min and max', () => {
      buffer.addSample(5, 1);
      buffer.addSample(1, 2);
      buffer.addSample(9, 3);
      expect(buffer.getMin()).toBe(1);
      expect(buffer.getMax()).toBe(9);
    });
  });

  describe('getStats', () => {
    it('returns comprehensive stats object', () => {
      for (let i = 1; i <= 3; i++) buffer.addSample(i * 10, i * 100);
      const stats = buffer.getStats();
      expect(stats.metricType).toBe(MetricType.CONNECTIONS);
      expect(stats.sampleCount).toBe(3);
      expect(stats.mean).toBe(20);
      expect(stats.latest).toBe(30);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(30);
      expect(stats.isReady).toBe(true);
    });

    it('returns latest=0 when buffer is empty', () => {
      expect(buffer.getStats().latest).toBe(0);
    });
  });

  describe('clear', () => {
    it('removes all samples', () => {
      for (let i = 0; i < 5; i++) buffer.addSample(i, i);
      buffer.clear();
      expect(buffer.getSampleCount()).toBe(0);
      expect(buffer.isReady()).toBe(false);
    });
  });
});
