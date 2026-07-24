// Wire-format mirrors of proprietary/anomaly-detection/types.ts — the web app
// cannot import from the optional proprietary module, so the response shapes
// are duplicated here. metricType/pattern stay open strings: the server-side
// enums grow without lockstep frontend releases.
export type AnomalySeverity = 'info' | 'warning' | 'critical';
export type AnomalyType = 'spike' | 'drop';

export interface AnomalyEvent {
  id: string;
  timestamp: number;
  metricType: string;
  anomalyType: AnomalyType;
  severity: AnomalySeverity;
  value: number;
  baseline: number;
  stdDev: number;
  zScore: number;
  threshold: number;
  message: string;
  correlationId?: string;
  relatedMetrics?: string[];
  resolved: boolean;
  connectionId?: string;
  persisted?: boolean;
}

export interface CorrelatedAnomalyGroup {
  correlationId: string;
  timestamp: number;
  anomalies: AnomalyEvent[];
  pattern: string;
  diagnosis: string;
  recommendations: string[];
  severity: AnomalySeverity;
}

export interface AnomalySummary {
  totalEvents: number;
  totalGroups: number;
  bySeverity: Record<string, number>;
  byMetric: Record<string, number>;
  byPattern: Record<string, number>;
  activeEvents: number;
  resolvedEvents: number;
}

export interface AnomalyBufferStats {
  metricType: string;
  connectionId?: string;
  sampleCount: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  latest: number;
  isReady: boolean;
}
