import type { CacheType } from '@betterdb/shared';

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
  type: 'semantic_cache';
  uncertain_hit_rate: number;
  category_breakdown: Array<{ category: string; hit_rate: number; ops: number }>;
}

export interface AgentCacheHealth extends CacheHealthCommon {
  type: 'agent_cache';
  tool_breakdown: Array<{
    tool: string;
    hit_rate: number;
    ops: number;
    cost_saved_usd: number;
  }>;
}

export type CacheHealth = SemanticCacheHealth | AgentCacheHealth;

export type ThresholdRecommendationKind =
  | 'tighten_threshold'
  | 'loosen_threshold'
  | 'optimal'
  | 'insufficient_data';

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

export type ToolEffectivenessRecommendation =
  | 'increase_ttl'
  | 'optimal'
  | 'decrease_ttl_or_disable';

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
