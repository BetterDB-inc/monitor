export type MetricKind = 'opsPerSec' | 'usedMemory' | 'cpuTotal' | 'memFragmentation';

export interface MetricForecastSettings {
  connectionId: string;
  metricKind: MetricKind;
  enabled: boolean;
  ceiling: number | null;
  rollingWindowMs: number;
  alertThresholdMs: number;
  updatedAt: number;
}

export interface MetricForecast {
  connectionId: string;
  metricKind: MetricKind;
  mode: 'trend' | 'forecast';
  currentValue: number;
  growthRate: number;
  growthPercent: number;
  trendDirection: 'rising' | 'falling' | 'stable';
  dataPointCount: number;
  windowMs: number;
  ceiling: number | null;
  timeToLimitMs: number | null;
  timeToLimitHuman: string;
  enabled: boolean;
  insufficientData: boolean;
  insufficientDataMessage?: string;
}

export interface MetricForecastSettingsUpdate {
  enabled?: boolean;
  ceiling?: number | null;
  rollingWindowMs?: number;
  alertThresholdMs?: number;
}

export interface MetricKindMeta {
  label: string;
  unit: string;
  unitLabel: string;
  ceilingLabel: string;
  defaultCeiling: number | null;
  valueFormatter: 'bytes' | 'percent' | 'ratio' | 'ops';
}

export const METRIC_KIND_META: Record<MetricKind, MetricKindMeta> = {
  opsPerSec: {
    label: 'Ops/sec',
    unit: 'ops/sec',
    unitLabel: 'ops/sec',
    ceilingLabel: 'Ops/sec Ceiling',
    defaultCeiling: null,
    valueFormatter: 'ops',
  },
  usedMemory: {
    label: 'Memory',
    unit: 'bytes',
    unitLabel: 'MB',
    ceilingLabel: 'Memory Ceiling',
    defaultCeiling: null,
    valueFormatter: 'bytes',
  },
  cpuTotal: {
    label: 'CPU',
    unit: 'percent',
    unitLabel: '%',
    ceilingLabel: 'CPU Ceiling',
    defaultCeiling: 100,
    valueFormatter: 'percent',
  },
  memFragmentation: {
    label: 'Fragmentation',
    unit: 'ratio',
    unitLabel: 'x',
    ceilingLabel: 'Fragmentation Ceiling',
    defaultCeiling: 1.5,
    valueFormatter: 'ratio',
  },
};

export const ALL_METRIC_KINDS: MetricKind[] = [
  'opsPerSec',
  'usedMemory',
  'cpuTotal',
  'memFragmentation',
];
