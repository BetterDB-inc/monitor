import type { CacheType, AGENT_CACHE, SEMANTIC_CACHE } from '@betterdb/shared';

export interface CacheListEntry {
  name: string;
  type: CacheType;
  prefix: string;
  hit_rate: number;
  total_ops: number;
  status: 'live' | 'stale' | 'unknown';
}

export interface CacheHealthWarning {
  level: 'info' | 'warn' | 'critical';
  message: string;
}

interface CacheHealthCommon {
  name: string;
  hit_rate: number;
  miss_rate: number;
  cost_saved_total_usd: number;
  total_ops: number;
  warnings: CacheHealthWarning[];
}

export interface SemanticCacheHealth extends CacheHealthCommon {
  type: typeof SEMANTIC_CACHE;
  uncertain_hit_rate: number;
  category_breakdown: Array<{ category: string; hit_rate: number; ops: number }>;
}

export interface AgentCacheHealth extends CacheHealthCommon {
  type: typeof AGENT_CACHE;
  tool_breakdown: Array<{
    tool: string;
    hit_rate: number;
    ops: number;
    cost_saved_usd: number;
  }>;
}

export type CacheHealth = SemanticCacheHealth | AgentCacheHealth;

export const THRESHOLD_RECOMMENDATIONS = {
  TIGHTEN: 'tighten_threshold',
  LOOSEN: 'loosen_threshold',
  OPTIMAL: 'optimal',
  INSUFFICIENT_DATA: 'insufficient_data',
} as const;

export type ThresholdRecommendationKind =
  (typeof THRESHOLD_RECOMMENDATIONS)[keyof typeof THRESHOLD_RECOMMENDATIONS];

const formatPct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const THRESHOLD_REASONINGS = {
  insufficientData: (sampleCount: number, minSamples: number): string =>
    `Only ${sampleCount} samples collected; ${minSamples} required for a reliable recommendation.`,
  tighten: (uncertainHitRate: number): string =>
    `${formatPct(uncertainHitRate)} of hits are in the uncertainty band — tighten the threshold.`,
  loosen: (nearMissRate: number): string =>
    `${formatPct(nearMissRate)} of misses are very close to the threshold — consider loosening.`,
  optimal: (hitRate: number, uncertainHitRate: number): string =>
    `Hit rate ${formatPct(hitRate)} with ${formatPct(uncertainHitRate)} uncertain hits — threshold appears well-calibrated.`,
} as const;

export interface ThresholdRecommendation {
  category: string;
  sample_count: number;
  current_threshold: number;
  hit_rate: number;
  uncertain_hit_rate: number;
  near_miss_rate: number;
  avg_hit_similarity: number;
  avg_miss_similarity: number;
  recommendation: ThresholdRecommendationKind;
  recommended_threshold?: number;
  reasoning: string;
}

export const TOOL_EFFECTIVENESS_RECOMMENDATIONS = {
  INCREASE_TTL: 'increase_ttl',
  OPTIMAL: 'optimal',
  DECREASE_TTL_OR_DISABLE: 'decrease_ttl_or_disable',
} as const;

export type ToolEffectivenessRecommendation =
  (typeof TOOL_EFFECTIVENESS_RECOMMENDATIONS)[keyof typeof TOOL_EFFECTIVENESS_RECOMMENDATIONS];

export interface ToolEffectivenessEntry {
  tool: string;
  hit_rate: number;
  cost_saved_usd: number;
  ttl_current: number | null;
  recommendation: ToolEffectivenessRecommendation;
}

export interface SimilarityDistributionBucket {
  lower: number;
  upper: number;
  hit_count: number;
  miss_count: number;
}

export interface SimilarityDistribution {
  total_samples: number;
  bucket_width: number;
  buckets: SimilarityDistributionBucket[];
}
