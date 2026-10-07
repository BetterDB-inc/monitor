export type ReadinessDimensionKey =
  | 'memory'
  | 'connections'
  | 'cpu'
  | 'opsTrend'
  | 'keyspaceGrowth';

export type ReadinessBand = 'green' | 'yellow' | 'red';

export interface ReadinessDimension {
  key: ReadinessDimensionKey;
  score: number | null;
  weight: number;
  contribution: number | null;
  detail: string | null;
  excludedReason: string | null;
}

export interface ScalingReadiness {
  connectionId: string;
  computedAt: number;
  score: number | null;
  band: ReadinessBand | null;
  bindingDimension: ReadinessDimensionKey | null;
  summary: string;
  cappedBy: ReadinessDimensionKey | null;
  dimensions: ReadinessDimension[];
}

export const READINESS_DIMENSION_LABELS: Record<ReadinessDimensionKey, string> = {
  memory: 'Memory',
  connections: 'Connections',
  cpu: 'CPU',
  opsTrend: 'Throughput trend',
  keyspaceGrowth: 'Keyspace growth',
};

export interface ScalingReadinessLowData {
  connectionId: string;
  score: number;
  threshold: number;
  band: ReadinessBand;
  bindingDimension: ReadinessDimensionKey | null;
  summary: string;
  dimensions: { key: ReadinessDimensionKey; score: number | null; excludedReason: string | null }[];
  timestamp: number;
  instance?: { host: string; port: number };
}

export interface ScalingReadinessSettings {
  connectionId: string;
  alertEnabled: boolean;
  alertThreshold: number;
  updatedAt: number;
}

export interface ScalingReadinessSettingsUpdate {
  alertEnabled?: boolean;
  alertThreshold?: number;
}

export interface ScalingReadinessHistoryPoint {
  timestamp: number;
  score: number;
  band: ReadinessBand;
  bindingDimension: ReadinessDimensionKey | null;
  dimensions: ReadinessDimension[];
}

export interface ScalingReadinessHistory {
  points: ScalingReadinessHistoryPoint[];
}

export const DEFAULT_SCALING_READINESS_ALERT_THRESHOLD = 40;
export const MAX_SCALING_READINESS_ALERT_THRESHOLD = 80;
