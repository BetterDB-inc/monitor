export interface ThroughputSettings {
  connectionId: string;
  enabled: boolean;
  opsCeiling: number | null;
  rollingWindowMs: number;
  alertThresholdMs: number;
  updatedAt: number;
}

export interface ThroughputForecast {
  connectionId: string;
  mode: 'trend' | 'forecast';
  currentOpsPerSec: number;
  growthRate: number;
  growthPercent: number;
  trendDirection: 'rising' | 'falling' | 'stable';
  dataPointCount: number;
  windowMs: number;
  opsCeiling: number | null;
  timeToLimitMs: number | null;
  timeToLimitHuman: string;
  enabled: boolean;
  insufficientData: boolean;
  insufficientDataMessage?: string;
}

export interface ThroughputSettingsUpdate {
  enabled?: boolean;
  opsCeiling?: number | null;
  rollingWindowMs?: number;
  alertThresholdMs?: number;
}
