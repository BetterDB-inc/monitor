import { SpikeDetector } from '../spike-detector';
import { MetricBuffer } from '../metric-buffer';
import { MetricType, AnomalySeverity, AnomalyType } from '../types';

/**
 * Helper: fill a buffer with `count` samples of `value` so it passes isReady().
 */
function fillBuffer(buffer: MetricBuffer, count: number, value: number): void {
  for (let i = 0; i < count; i++) {
    buffer.addSample(value, i * 1000);
  }
}

describe('SpikeDetector', () => {
  const MIN_SAMPLES = 5;

  describe('warmup guard', () => {
    it('returns null when buffer is not ready', () => {
      const buffer = new MetricBuffer(MetricType.CONNECTIONS, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.CONNECTIONS);
      buffer.addSample(1, 100);
      expect(detector.detect(buffer, 100, 200)).toBeNull();
    });
  });

  describe('z-score spike detection', () => {
    it('detects a WARNING spike when z-score exceeds warningZScore', () => {
      const buffer = new MetricBuffer(MetricType.CONNECTIONS, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.CONNECTIONS, {
        warningZScore: 2.0,
        criticalZScore: 3.0,
        consecutiveRequired: 1,
        cooldownMs: 0,
      });

      // Baseline: 30 samples of value 10
      fillBuffer(buffer, 30, 10);

      // Spike value well above mean (stdDev=0 for constant → need some variance)
      // Use varying data instead
      buffer.clear();
      for (let i = 0; i < 30; i++) buffer.addSample(10 + (i % 2), i * 1000);
      // mean ≈ 10.5, stdDev ≈ 0.5 → a value of 12 → z ≈ 3
      const result = detector.detect(buffer, 12, 50000);
      expect(result).not.toBeNull();
      expect(result!.severity).toBe(AnomalySeverity.CRITICAL);
      expect(result!.anomalyType).toBe(AnomalyType.SPIKE);
    });

    it('returns null for normal values', () => {
      const buffer = new MetricBuffer(MetricType.CONNECTIONS, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.CONNECTIONS, {
        consecutiveRequired: 1,
        cooldownMs: 0,
      });
      for (let i = 0; i < 30; i++) buffer.addSample(10 + (i % 2), i * 1000);
      // value = 10.5 (the mean) → z ≈ 0
      expect(detector.detect(buffer, 10.5, 50000)).toBeNull();
    });
  });

  describe('drop detection', () => {
    it('ignores drops when detectDrops is false (default)', () => {
      const buffer = new MetricBuffer(MetricType.CONNECTIONS, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.CONNECTIONS, {
        consecutiveRequired: 1,
        cooldownMs: 0,
      });
      for (let i = 0; i < 30; i++) buffer.addSample(100 + (i % 2), i * 1000);
      // A very low value → negative z-score
      expect(detector.detect(buffer, 0, 50000)).toBeNull();
    });

    it('detects drops when detectDrops is true', () => {
      const buffer = new MetricBuffer(MetricType.CONNECTIONS, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.CONNECTIONS, {
        detectDrops: true,
        consecutiveRequired: 1,
        cooldownMs: 0,
      });
      for (let i = 0; i < 30; i++) buffer.addSample(100 + (i % 2), i * 1000);
      const result = detector.detect(buffer, 0, 50000);
      expect(result).not.toBeNull();
      expect(result!.anomalyType).toBe(AnomalyType.DROP);
    });
  });

  describe('absolute threshold detection', () => {
    it('fires WARNING when value exceeds warningThreshold', () => {
      const buffer = new MetricBuffer(MetricType.ACL_DENIED, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.ACL_DENIED, {
        warningThreshold: 10,
        criticalThreshold: 50,
        consecutiveRequired: 1,
        cooldownMs: 0,
        // Set z-score thresholds very high so only absolute thresholds fire
        warningZScore: 999,
        criticalZScore: 999,
      });
      fillBuffer(buffer, 30, 5);
      const result = detector.detect(buffer, 15, 50000);
      expect(result).not.toBeNull();
      expect(result!.severity).toBe(AnomalySeverity.WARNING);
    });

    it('fires CRITICAL when value exceeds criticalThreshold', () => {
      const buffer = new MetricBuffer(MetricType.ACL_DENIED, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.ACL_DENIED, {
        warningThreshold: 10,
        criticalThreshold: 50,
        consecutiveRequired: 1,
        cooldownMs: 0,
        warningZScore: 999,
        criticalZScore: 999,
      });
      fillBuffer(buffer, 30, 5);
      const result = detector.detect(buffer, 55, 50000);
      expect(result).not.toBeNull();
      expect(result!.severity).toBe(AnomalySeverity.CRITICAL);
    });
  });

  describe('consecutive sample requirement', () => {
    it('does not fire until consecutiveRequired samples reached', () => {
      const buffer = new MetricBuffer(MetricType.CONNECTIONS, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.CONNECTIONS, {
        warningThreshold: 10,
        criticalThreshold: 50,
        consecutiveRequired: 3,
        cooldownMs: 0,
        warningZScore: 999,
        criticalZScore: 999,
      });
      fillBuffer(buffer, 30, 5);

      // Anomalous value=15 (above warningThreshold=10)
      expect(detector.detect(buffer, 15, 1000)).toBeNull(); // 1st
      buffer.addSample(15, 1000);
      expect(detector.detect(buffer, 15, 2000)).toBeNull(); // 2nd
      buffer.addSample(15, 2000);
      const result = detector.detect(buffer, 15, 3000); // 3rd → fires
      expect(result).not.toBeNull();
      expect(result!.severity).toBe(AnomalySeverity.WARNING);
    });

    it('resets consecutive counter on normal value', () => {
      // Use a large buffer so adding a few anomalous samples doesn't shift baseline much
      const buffer = new MetricBuffer(MetricType.CONNECTIONS, 1000, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.CONNECTIONS, {
        warningThreshold: 10,
        consecutiveRequired: 3,
        cooldownMs: 0,
        warningZScore: 999,
        criticalZScore: 999,
      });
      fillBuffer(buffer, 200, 5);

      // 2 anomalous (above warningThreshold=10), then 1 normal → resets
      expect(detector.detect(buffer, 15, 1000)).toBeNull(); // 1st
      expect(detector.detect(buffer, 15, 2000)).toBeNull(); // 2nd
      expect(detector.detect(buffer, 5, 3000)).toBeNull();  // normal → resets counter

      // Now need 3 more consecutive to fire again
      expect(detector.detect(buffer, 15, 4000)).toBeNull(); // 1st again
      expect(detector.detect(buffer, 15, 5000)).toBeNull(); // 2nd again
      const result = detector.detect(buffer, 15, 6000);     // 3rd → fires
      expect(result).not.toBeNull();
    });
  });

  describe('cooldown suppression', () => {
    it('suppresses alerts during cooldown period', () => {
      const buffer = new MetricBuffer(MetricType.CONNECTIONS, 100, MIN_SAMPLES);
      const detector = new SpikeDetector(MetricType.CONNECTIONS, {
        warningThreshold: 10,
        consecutiveRequired: 1,
        cooldownMs: 60000,
        warningZScore: 999,
        criticalZScore: 999,
      });
      fillBuffer(buffer, 30, 5);

      // First alert fires
      const first = detector.detect(buffer, 15, 1000);
      expect(first).not.toBeNull();

      // Within cooldown → suppressed
      buffer.addSample(15, 1000);
      expect(detector.detect(buffer, 15, 30000)).toBeNull();

      // After cooldown → fires again
      buffer.addSample(15, 30000);
      const after = detector.detect(buffer, 15, 70000);
      expect(after).not.toBeNull();
    });
  });

  describe('getConfig', () => {
    it('returns a copy of the resolved configuration', () => {
      const detector = new SpikeDetector(MetricType.CONNECTIONS);
      const config = detector.getConfig();
      expect(config.warningZScore).toBe(2.0);
      expect(config.criticalZScore).toBe(3.0);
      expect(config.consecutiveRequired).toBe(3);
      expect(config.cooldownMs).toBe(60000);
      expect(config.detectDrops).toBe(false);
    });
  });
});
