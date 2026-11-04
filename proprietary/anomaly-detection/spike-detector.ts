import { randomUUID } from 'crypto';
import { MetricBuffer } from './metric-buffer';
import {
  MetricType,
  AnomalyEvent,
  AnomalySeverity,
  AnomalyType,
  SpikeDetectorConfig,
} from './types';

export interface SpikeDetectorOptions {
  minValue?: number;
  zScoreCritical?: boolean;
  absoluteBelowMean?: boolean;
}

interface ConsecutiveCounter {
  count: number;
  lastValue: number;
  lastTimestamp: number;
}

export class SpikeDetector {
  private config: Required<SpikeDetectorConfig>;
  private consecutiveCounts = new Map<MetricType, ConsecutiveCounter>();
  private lastAlertTime = new Map<MetricType, number>();
  private readonly options: Required<SpikeDetectorOptions>;

  constructor(
    private readonly metricType: MetricType,
    config: SpikeDetectorConfig = {},
    options: SpikeDetectorOptions = {},
  ) {
    this.options = {
      minValue: options.minValue ?? Number.NEGATIVE_INFINITY,
      zScoreCritical: options.zScoreCritical ?? true,
      absoluteBelowMean: options.absoluteBelowMean ?? false,
    };
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

  resetRun(): void {
    this.consecutiveCounts.delete(this.metricType);
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
    const isDrop = zScore < 0;

    const exceedsAbsolute =
      (!isDrop || this.options.absoluteBelowMean) &&
      currentValue >= Math.min(this.config.warningThreshold, this.config.criticalThreshold);

    if (currentValue < this.options.minValue && !exceedsAbsolute) {
      this.consecutiveCounts.delete(this.metricType);
      return null;
    }
    const countsAsDrop = isDrop && this.config.detectDrops;

    // Skip drops if not configured to detect them
    if (isDrop && !countsAsDrop && !exceedsAbsolute) {
      if (this.options.absoluteBelowMean) {
        this.consecutiveCounts.delete(this.metricType);
      }
      return null;
    }

    const absZScore = isDrop && !countsAsDrop ? 0 : Math.abs(zScore);

    // Check Z-score thresholds
    let zSeverity: AnomalySeverity | null = null;
    let zThreshold = 0;
    if (this.options.zScoreCritical && absZScore >= this.config.criticalZScore) {
      zSeverity = AnomalySeverity.CRITICAL;
      zThreshold = this.config.criticalZScore;
    } else if (absZScore >= this.config.warningZScore) {
      zSeverity = AnomalySeverity.WARNING;
      zThreshold = this.config.warningZScore;
    }

    let absSeverity: AnomalySeverity | null = null;
    let absThreshold = 0;
    if (currentValue >= this.config.criticalThreshold) {
      absSeverity = AnomalySeverity.CRITICAL;
      absThreshold = this.config.criticalThreshold;
    } else if (currentValue >= this.config.warningThreshold) {
      absSeverity = AnomalySeverity.WARNING;
      absThreshold = this.config.warningThreshold;
    }

    const byThreshold =
      absSeverity !== null &&
      (zSeverity === null ||
        absSeverity === AnomalySeverity.CRITICAL ||
        zSeverity === AnomalySeverity.WARNING);
    const severity = byThreshold ? absSeverity : zSeverity;
    const threshold = byThreshold ? absThreshold : zThreshold;

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

    const anomalyType = countsAsDrop && !byThreshold ? AnomalyType.DROP : AnomalyType.SPIKE;
    const message = this.generateMessage(
      anomalyType,
      byThreshold,
      severity,
      currentValue,
      mean,
      zScore,
      threshold,
    );

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
    byThreshold: boolean,
    severity: AnomalySeverity,
    value: number,
    baseline: number,
    zScore: number,
    threshold: number,
  ): string {
    if (byThreshold) {
      return (
        `${severity.toUpperCase()}: ${this.metricType} above threshold. ` +
        `Value: ${this.formatBoundary(value)}, Threshold: ${this.formatBoundary(threshold)} ` +
        `(Baseline: ${this.formatValue(baseline)}, Z-score: ${zScore.toFixed(2)})`
      );
    }
    const typeStr = type === AnomalyType.SPIKE ? 'spike' : 'drop';

    return (
      `${severity.toUpperCase()}: ${this.metricType} ${typeStr} detected. ` +
      `Value: ${this.formatValue(value)}, Baseline: ${this.formatValue(baseline)} ` +
      `(${this.describeChange(value, baseline)}, Z-score: ${zScore.toFixed(2)})`
    );
  }

  private describeChange(value: number, baseline: number): string {
    if (baseline === 0) {
      return 'above a zero baseline';
    }
    const change = Math.abs(((value - baseline) / baseline) * 100).toFixed(1);
    return `${change}% ${value < baseline ? 'below' : 'above'} normal`;
  }

  private formatBoundary(value: number): string {
    return String(Number(value.toPrecision(12)));
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

  /**
   * Hot-reloads detector thresholds without resetting the circular buffer.
   * Callers pass a fully-resolved config (produced via
   * `toSpikeDetectorConfig(resolveDetectorConfig(...))`), so this method
   * requires the `Required<>` variant — that keeps `DETECTOR_DEFAULTS` in
   * `apps/api/src/anomaly/anomaly.types.ts` as the single source of truth for
   * defaults. `detectDrops` is fixed at construction and is never changed by a
   * hot reload: the API does not expose it, so the incoming value is ignored.
   */
  updateConfig(config: Required<SpikeDetectorConfig>): void {
    this.config = { ...config, detectDrops: this.config.detectDrops };
  }
}
