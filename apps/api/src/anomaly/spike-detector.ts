import { randomUUID } from 'crypto';
import { MetricBuffer } from './metric-buffer';
import {
  MetricType,
  AnomalyEvent,
  AnomalySeverity,
  AnomalyType,
  SpikeDetectorConfig,
} from './types';

interface ConsecutiveCounter {
  count: number;
  lastValue: number;
  lastTimestamp: number;
}

export class SpikeDetector {
  private config: Required<SpikeDetectorConfig>;
  private consecutiveCounts = new Map<MetricType, ConsecutiveCounter>();
  private lastAlertTime = new Map<MetricType, number>();

  constructor(
    private readonly metricType: MetricType,
    config: SpikeDetectorConfig = {},
  ) {
    // Set defaults
    this.config = {
      warningZScore: config.warningZScore ?? 2.0,
      criticalZScore: config.criticalZScore ?? 3.0,
      warningThreshold: config.warningThreshold ?? Number.POSITIVE_INFINITY,
      criticalThreshold: config.criticalThreshold ?? Number.POSITIVE_INFINITY,
      consecutiveRequired: config.consecutiveRequired ?? 3,
      cooldownMs: config.cooldownMs ?? 60000, // 1 minute default
      detectDrops: config.detectDrops ?? false,
    };
  }

  detect(buffer: MetricBuffer, currentValue: number, timestamp: number): AnomalyEvent | null {
    if (!buffer.isReady()) {
      return null;
    }

    // Check cooldown
    const lastAlert = this.lastAlertTime.get(this.metricType);
    if (lastAlert && timestamp - lastAlert < this.config.cooldownMs) {
      return null;
    }

    const mean = buffer.getMean();
    const stdDev = buffer.getStdDev();
    const zScore = buffer.getZScore(currentValue);

    // Determine if this is a spike or drop
    const isSpike = zScore > 0;
    const isDrop = zScore < 0;

    // Skip drops if not configured to detect them
    if (isDrop && !this.config.detectDrops) {
      return null;
    }

    const absZScore = Math.abs(zScore);

    // Check Z-score thresholds
    let severity: AnomalySeverity | null = null;
    let threshold: number = 0;

    if (absZScore >= this.config.criticalZScore) {
      severity = AnomalySeverity.CRITICAL;
      threshold = this.config.criticalZScore;
    } else if (absZScore >= this.config.warningZScore) {
      severity = AnomalySeverity.WARNING;
      threshold = this.config.warningZScore;
    }

    // Also check absolute thresholds
    if (currentValue >= this.config.criticalThreshold) {
      severity = AnomalySeverity.CRITICAL;
      threshold = this.config.criticalThreshold;
    } else if (currentValue >= this.config.warningThreshold && !severity) {
      severity = AnomalySeverity.WARNING;
      threshold = this.config.warningThreshold;
    }

    if (!severity) {
      // Reset consecutive counter
      this.consecutiveCounts.delete(this.metricType);
      return null;
    }

    // Check consecutive requirements
    const counter = this.consecutiveCounts.get(this.metricType);
    if (counter) {
      counter.count++;
      counter.lastValue = currentValue;
      counter.lastTimestamp = timestamp;
    } else {
      this.consecutiveCounts.set(this.metricType, {
        count: 1,
        lastValue: currentValue,
        lastTimestamp: timestamp,
      });
    }

    const currentCounter = this.consecutiveCounts.get(this.metricType)!;
    if (currentCounter.count < this.config.consecutiveRequired) {
      return null; // Not enough consecutive samples
    }

    // Create anomaly event
    this.lastAlertTime.set(this.metricType, timestamp);
    this.consecutiveCounts.delete(this.metricType); // Reset after alert

    const anomalyType = isSpike ? AnomalyType.SPIKE : AnomalyType.DROP;
    const message = this.generateMessage(anomalyType, severity, currentValue, mean, zScore);

    return {
      id: randomUUID(),
      timestamp,
      metricType: this.metricType,
      anomalyType,
      severity,
      value: currentValue,
      baseline: mean,
      stdDev,
      zScore,
      threshold,
      message,
      resolved: false,
    };
  }

  private generateMessage(
    type: AnomalyType,
    severity: AnomalySeverity,
    value: number,
    baseline: number,
    zScore: number,
  ): string {
    const typeStr = type === AnomalyType.SPIKE ? 'spike' : 'drop';
    const change = ((value - baseline) / baseline * 100).toFixed(1);
    const direction = type === AnomalyType.SPIKE ? 'above' : 'below';

    return `${severity.toUpperCase()}: ${this.metricType} ${typeStr} detected. ` +
           `Value: ${this.formatValue(value)}, Baseline: ${this.formatValue(baseline)} ` +
           `(${change}% ${direction} normal, Z-score: ${zScore.toFixed(2)})`;
  }

  private formatValue(value: number): string {
    if (this.metricType === MetricType.MEMORY_USED) {
      // Format bytes
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)} MB`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(2)} KB`;
      return `${value} B`;
    }

    if (this.metricType === MetricType.FRAGMENTATION_RATIO) {
      return value.toFixed(2);
    }

    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;

    return value.toFixed(0);
  }

  getConfig(): Required<SpikeDetectorConfig> {
    return { ...this.config };
  }
}
