export interface QueryPair {
  promptA: string;
  promptB: string;
  isSemanticMatch: boolean;
  category?: string;
  source?: string;
}

export interface CheckResult {
  hit: boolean;
  similarityScore: number | null;
}

export interface ReplayResult {
  promptA: string;
  promptB: string;
  isSemanticMatch: boolean;
  hit: boolean;
  similarityScore: number | null;
  latencyMs: number;
  category?: string;
}

export interface Metrics {
  total: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  hitRate: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  meanSimilarityOnHits: number;
}

export interface BenchmarkResult {
  adapter: string;
  mode: string;
  dataset: string;
  initialThreshold: number;
  finalThreshold: number;
  embeddingModel: string;
  enabledFeatures: string[];
  metrics: Metrics;
  results: ReplayResult[];
}

export type AdapterMode = 'bare' | 'local' | 'full' | 'autotune' | 'autotune-full';
