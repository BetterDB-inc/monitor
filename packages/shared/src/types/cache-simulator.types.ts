export type CacheSimulatorStatus = 'sampling' | 'ready' | 'failed';

export interface CacheSimulatorInstant {
  usedMemory: number;
  maxmemory: number;
  maxmemoryPolicy: string;
  totalKeys: number;
}

export interface CacheSimulatorTypeEstimate {
  type: string;
  keys: number;
  avgBytes: number;
  stdBytes: number;
  sampled: number;
}

export interface CacheSimulatorEstimate {
  totalBytes: number;
  ci95Bytes: number;
  avgKeyBytes: number;
  stdKeyBytes: number;
  sampleCount: number;
  byType: CacheSimulatorTypeEstimate[];
  sampledAt: number;
  partial: boolean;
  likelyMissedLargeKeys: boolean;
}

export interface CacheSimulatorGrowth {
  keysPerDay: number;
  bytesPerDay: number;
  days: number;
}

export interface CacheSimulatorSnapshot {
  status: CacheSimulatorStatus;
  progress: { sampled: number; target: number } | null;
  instant: CacheSimulatorInstant;
  estimate: CacheSimulatorEstimate | null;
  growth: CacheSimulatorGrowth | null;
  error?: string;
}
