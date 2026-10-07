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
