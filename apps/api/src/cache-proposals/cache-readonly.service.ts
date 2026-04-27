import { Inject, Injectable, Logger } from '@nestjs/common';
import type Valkey from 'iovalkey';
import type { CacheType, StoredCacheProposal } from '@betterdb/shared';
import { AGENT_CACHE, REGISTRY_KEY, SEMANTIC_CACHE, heartbeatKeyFor } from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { CacheResolverService, type ResolvedCache } from './cache-resolver.service';
import { CacheNotFoundError, InvalidCacheTypeError } from './errors';
import { readHashInt } from '../common/utils/valkey-fields';
import type {
  CacheHealth,
  CacheHealthWarning,
  CacheListEntry,
  SimilarityDistribution,
  SimilarityDistributionBucket,
  ThresholdRecommendation,
  ThresholdRecommendationKind,
  ToolEffectivenessEntry,
  ToolEffectivenessRecommendation,
} from './cache-readonly.types';
import { DatabasePort } from '@app/common/interfaces/database-port.interface';

export type {
  CacheHealth,
  CacheHealthWarning,
  CacheListEntry,
  SemanticCacheHealth,
  AgentCacheHealth,
  SimilarityDistribution,
  SimilarityDistributionBucket,
  ThresholdRecommendation,
  ThresholdRecommendationKind,
  ToolEffectivenessEntry,
  ToolEffectivenessRecommendation,
} from './cache-readonly.types';

const DEFAULT_THRESHOLD_MIN_SAMPLES = 100;
const DEFAULT_DISTRIBUTION_WINDOW_HOURS = 24;
const DISTRIBUTION_BUCKETS = 20;
const DISTRIBUTION_BUCKET_WIDTH = 0.1;
const DEFAULT_RECENT_CHANGES_LIMIT = 20;
const RECENT_CHANGES_MAX_LIMIT = 200;

const DEFAULT_SEMANTIC_THRESHOLD = 0.1;
const DEFAULT_UNCERTAINTY_BAND = 0.05;

interface MarkerRecord {
  name: string;
  type: CacheType;
  prefix: string;
  capabilities: string[];
  protocol_version: number;
}

interface SemanticConfig {
  default_threshold: number;
  category_thresholds: Record<string, number>;
  uncertainty_band: number;
}

@Injectable()
export class CacheReadonlyService {
  private readonly logger = new Logger(CacheReadonlyService.name);

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly resolver: CacheResolverService,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {}

  async listCaches(connectionId: string): Promise<CacheListEntry[]> {
    const client = this.getClient(connectionId);
    const raw = await client.hgetall(REGISTRY_KEY);
    const markers = this.parseRegistry(raw ?? {});
    if (markers.length === 0) {
      return [];
    }

    const entries: CacheListEntry[] = [];
    for (const marker of markers) {
      const stats = await this.readBaseStats(client, marker.name);
      const heartbeat = await client.get(heartbeatKeyFor(marker.name));
      const status: CacheListEntry['status'] = heartbeat === null ? 'stale' : 'live';
      entries.push({
        name: marker.name,
        type: marker.type,
        prefix: marker.prefix,
        hit_rate: stats.total === 0 ? 0 : stats.hits / stats.total,
        total_ops: stats.total,
        status,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async cacheHealth(connectionId: string, cacheName: string): Promise<CacheHealth> {
    const cache = await this.requireCache(connectionId, cacheName);
    const client = this.getClient(connectionId);
    const statsKey = `${cache.prefix}:__stats`;
    const raw = (await client.hgetall(statsKey)) ?? {};

    if (cache.type === SEMANTIC_CACHE) {
      const hits = readHashInt(raw, 'hits');
      const misses = readHashInt(raw, 'misses');
      const total = readHashInt(raw, 'total') || hits + misses;
      const costSavedMicros = readHashInt(raw, 'cost_saved_micros');
      const samples = await this.readSimilarityWindow(client, cache.prefix);
      const config = await this.readSemanticConfig(client, cache.prefix);
      const hitRate = total === 0 ? 0 : hits / total;
      const uncertain = samples.filter(
        (s) => s.result === 'hit' && s.score >= config.default_threshold - config.uncertainty_band,
      ).length;
      const totalHitsInWindow = samples.filter((s) => s.result === 'hit').length;
      const uncertainHitRate = totalHitsInWindow === 0 ? 0 : uncertain / totalHitsInWindow;

      const categoryBreakdown = this.computeCategoryBreakdown(samples);
      const warnings = this.deriveSemanticWarnings(hitRate, uncertainHitRate, total);

      return {
        type: SEMANTIC_CACHE,
        name: cache.name,
        hit_rate: hitRate,
        miss_rate: total === 0 ? 0 : misses / total,
        cost_saved_total_usd: costSavedMicros / 1_000_000,
        total_ops: total,
        uncertain_hit_rate: uncertainHitRate,
        category_breakdown: categoryBreakdown,
        warnings,
      };
    }

    const llmHits = readHashInt(raw, 'llm:hits');
    const llmMisses = readHashInt(raw, 'llm:misses');
    const toolHits = readHashInt(raw, 'tool:hits');
    const toolMisses = readHashInt(raw, 'tool:misses');
    const totalHits = llmHits + toolHits;
    const totalMisses = llmMisses + toolMisses;
    const total = totalHits + totalMisses;
    const costSavedMicros = readHashInt(raw, 'cost_saved_micros');
    const tools = this.extractAgentToolStats(raw);
    const toolBreakdown = Object.entries(tools)
      .map(([tool, s]) => ({
        tool,
        hit_rate: s.hits + s.misses === 0 ? 0 : s.hits / (s.hits + s.misses),
        ops: s.hits + s.misses,
        cost_saved_usd: s.costSavedMicros / 1_000_000,
      }))
      .sort((a, b) => b.cost_saved_usd - a.cost_saved_usd);
    const warnings = this.deriveAgentWarnings(totalHits, total);

    return {
      type: AGENT_CACHE,
      name: cache.name,
      hit_rate: total === 0 ? 0 : totalHits / total,
      miss_rate: total === 0 ? 0 : totalMisses / total,
      cost_saved_total_usd: costSavedMicros / 1_000_000,
      total_ops: total,
      tool_breakdown: toolBreakdown,
      warnings,
    };
  }

  async thresholdRecommendation(
    connectionId: string,
    cacheName: string,
    options: { category?: string; minSamples?: number } = {},
  ): Promise<ThresholdRecommendation> {
    const cache = await this.requireCacheOfType(connectionId, cacheName, SEMANTIC_CACHE);
    const client = this.getClient(connectionId);
    const samples = await this.readSimilarityWindow(client, cache.prefix);
    const config = await this.readSemanticConfig(client, cache.prefix);
    const minSamples = options.minSamples ?? DEFAULT_THRESHOLD_MIN_SAMPLES;
    const category = options.category;
    const filtered = category ? samples.filter((s) => s.category === category) : samples;
    const threshold =
      category !== undefined && config.category_thresholds[category] !== undefined
        ? config.category_thresholds[category]
        : config.default_threshold;

    const sampleCount = filtered.length;
    const categoryLabel = category ?? 'all';
    if (sampleCount < minSamples) {
      return {
        category: categoryLabel,
        sample_count: sampleCount,
        current_threshold: threshold,
        hit_rate: 0,
        uncertain_hit_rate: 0,
        near_miss_rate: 0,
        avg_hit_similarity: 0,
        avg_miss_similarity: 0,
        recommendation: 'insufficient_data',
        reasoning: `Only ${sampleCount} samples collected; ${minSamples} required for a reliable recommendation.`,
      };
    }
    const hits = filtered.filter((s) => s.result === 'hit');
    const misses = filtered.filter((s) => s.result === 'miss');
    const hitRate = hits.length / sampleCount;
    const uncertainHits = hits.filter((s) => s.score >= threshold - config.uncertainty_band);
    const uncertainHitRate = hits.length === 0 ? 0 : uncertainHits.length / hits.length;
    const nearMisses = misses.filter((s) => s.score > threshold && s.score <= threshold + 0.03);
    const nearMissRate = misses.length === 0 ? 0 : nearMisses.length / misses.length;
    const avgHitSimilarity =
      hits.length === 0 ? 0 : hits.reduce((acc, s) => acc + s.score, 0) / hits.length;
    const avgMissSimilarity =
      misses.length === 0 ? 0 : misses.reduce((acc, s) => acc + s.score, 0) / misses.length;
    const avgNearMissDelta =
      nearMisses.length === 0
        ? 0
        : nearMisses.reduce((acc, s) => acc + (s.score - threshold), 0) / nearMisses.length;

    let recommendation: ThresholdRecommendationKind;
    let recommendedThreshold: number | undefined;
    let reasoning: string;
    if (uncertainHitRate > 0.2) {
      recommendation = 'tighten_threshold';
      recommendedThreshold = Math.max(0, threshold - config.uncertainty_band * 1.5);
      reasoning = `${(uncertainHitRate * 100).toFixed(1)}% of hits are in the uncertainty band — tighten the threshold.`;
    } else if (nearMissRate > 0.3 && avgNearMissDelta < 0.03) {
      recommendation = 'loosen_threshold';
      recommendedThreshold = threshold + avgNearMissDelta;
      reasoning = `${(nearMissRate * 100).toFixed(1)}% of misses are very close to the threshold — consider loosening.`;
    } else {
      recommendation = 'optimal';
      reasoning = `Hit rate ${(hitRate * 100).toFixed(1)}% with ${(uncertainHitRate * 100).toFixed(1)}% uncertain hits — threshold appears well-calibrated.`;
    }

    return {
      category: categoryLabel,
      sample_count: sampleCount,
      current_threshold: threshold,
      hit_rate: hitRate,
      uncertain_hit_rate: uncertainHitRate,
      near_miss_rate: nearMissRate,
      avg_hit_similarity: avgHitSimilarity,
      avg_miss_similarity: avgMissSimilarity,
      recommendation,
      recommended_threshold: recommendedThreshold,
      reasoning,
    };
  }

  async toolEffectiveness(
    connectionId: string,
    cacheName: string,
  ): Promise<ToolEffectivenessEntry[]> {
    const cache = await this.requireCacheOfType(connectionId, cacheName, AGENT_CACHE);
    const client = this.getClient(connectionId);
    const raw = (await client.hgetall(`${cache.prefix}:__stats`)) ?? {};
    const tools = this.extractAgentToolStats(raw);

    const entries: ToolEffectivenessEntry[] = [];
    for (const [toolName, s] of Object.entries(tools)) {
      const total = s.hits + s.misses;
      const hitRate = total === 0 ? 0 : s.hits / total;
      const policyTtl = await this.readToolPolicyTtl(client, cache.prefix, toolName);
      let recommendation: ToolEffectivenessRecommendation;
      if (hitRate > 0.8) {
        recommendation = policyTtl !== null && policyTtl < 3600 ? 'increase_ttl' : 'optimal';
      } else if (hitRate >= 0.4) {
        recommendation = 'optimal';
      } else {
        recommendation = 'decrease_ttl_or_disable';
      }
      entries.push({
        tool: toolName,
        hit_rate: hitRate,
        cost_saved_usd: s.costSavedMicros / 1_000_000,
        ttl_current: policyTtl,
        recommendation,
      });
    }
    entries.sort((a, b) => b.cost_saved_usd - a.cost_saved_usd);
    return entries;
  }

  async similarityDistribution(
    connectionId: string,
    cacheName: string,
    options: { category?: string; windowHours?: number } = {},
  ): Promise<SimilarityDistribution> {
    const cache = await this.requireCacheOfType(connectionId, cacheName, SEMANTIC_CACHE);
    const client = this.getClient(connectionId);
    const samples = await this.readSimilarityWindow(client, cache.prefix);
    const cutoff =
      Date.now() - (options.windowHours ?? DEFAULT_DISTRIBUTION_WINDOW_HOURS) * 60 * 60 * 1000;
    const filtered = samples.filter((s) => {
      if (s.recordedAt < cutoff) {
        return false;
      }
      return options.category === undefined || s.category === options.category;
    });

    const buckets: SimilarityDistributionBucket[] = [];
    for (let i = 0; i < DISTRIBUTION_BUCKETS; i += 1) {
      buckets.push({
        lower: i * DISTRIBUTION_BUCKET_WIDTH,
        upper: (i + 1) * DISTRIBUTION_BUCKET_WIDTH,
        hit_count: 0,
        miss_count: 0,
      });
    }
    for (const sample of filtered) {
      const idx = Math.min(
        DISTRIBUTION_BUCKETS - 1,
        Math.max(0, Math.floor(sample.score / DISTRIBUTION_BUCKET_WIDTH)),
      );
      if (sample.result === 'hit') {
        buckets[idx].hit_count += 1;
      } else {
        buckets[idx].miss_count += 1;
      }
    }
    return {
      total_samples: filtered.length,
      bucket_width: DISTRIBUTION_BUCKET_WIDTH,
      buckets,
    };
  }

  async recentChanges(
    connectionId: string,
    cacheName: string,
    limit: number = DEFAULT_RECENT_CHANGES_LIMIT,
  ): Promise<StoredCacheProposal[]> {
    const safeLimit = Math.max(1, Math.min(limit, RECENT_CHANGES_MAX_LIMIT));
    return this.storage.listCacheProposals({
      connection_id: connectionId,
      cache_name: cacheName,
      limit: safeLimit,
    });
  }

  private async requireCache(connectionId: string, cacheName: string): Promise<ResolvedCache> {
    const cache = await this.resolver.resolveCacheByName(connectionId, cacheName);
    if (cache === null) {
      throw new CacheNotFoundError(cacheName);
    }
    return cache;
  }

  private async requireCacheOfType(
    connectionId: string,
    cacheName: string,
    expected: CacheType,
  ): Promise<ResolvedCache> {
    const cache = await this.requireCache(connectionId, cacheName);
    if (cache.type !== expected) {
      throw new InvalidCacheTypeError(expected, cache.type, cacheName);
    }
    return cache;
  }

  private parseRegistry(raw: Record<string, string>): MarkerRecord[] {
    const out: MarkerRecord[] = [];
    for (const [name, json] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        if (parsed.type !== AGENT_CACHE && parsed.type !== SEMANTIC_CACHE) {
          continue;
        }
        if (typeof parsed.prefix !== 'string' || parsed.prefix.length === 0) {
          continue;
        }
        out.push({
          name,
          type: parsed.type as CacheType,
          prefix: parsed.prefix,
          capabilities: Array.isArray(parsed.capabilities)
            ? parsed.capabilities.filter((c): c is string => typeof c === 'string')
            : [],
          protocol_version:
            typeof parsed.protocol_version === 'number' ? parsed.protocol_version : 1,
        });
      } catch {
        this.logger.warn(`Skipping malformed marker for cache '${name}'`);
      }
    }
    return out;
  }

  private async readBaseStats(
    client: Valkey,
    prefix: string,
  ): Promise<{ hits: number; misses: number; total: number }> {
    const raw = (await client.hgetall(`${prefix}:__stats`)) ?? {};
    const hits =
      readHashInt(raw, 'hits') + readHashInt(raw, 'llm:hits') + readHashInt(raw, 'tool:hits');
    const misses =
      readHashInt(raw, 'misses') + readHashInt(raw, 'llm:misses') + readHashInt(raw, 'tool:misses');
    const explicitTotal = readHashInt(raw, 'total');
    return { hits, misses, total: explicitTotal === 0 ? hits + misses : explicitTotal };
  }

  private async readSimilarityWindow(
    client: Valkey,
    prefix: string,
  ): Promise<
    Array<{ score: number; result: 'hit' | 'miss'; category: string; recordedAt: number }>
  > {
    let raw: Array<string | number>;
    try {
      raw = (await client.zrange(
        `${prefix}:__similarity_window`,
        '0',
        '-1',
        'WITHSCORES',
      )) as Array<string | number>;
    } catch {
      return [];
    }
    const out: Array<{
      score: number;
      result: 'hit' | 'miss';
      category: string;
      recordedAt: number;
    }> = [];
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i];
      const recordedAt = Number(raw[i + 1]);
      if (typeof member !== 'string') {
        continue;
      }
      try {
        const entry = JSON.parse(member) as Record<string, unknown>;
        const score = typeof entry.score === 'number' ? entry.score : NaN;
        const result = entry.result;
        const category = typeof entry.category === 'string' ? entry.category : 'all';
        if (!Number.isFinite(score)) {
          continue;
        }
        if (result !== 'hit' && result !== 'miss') {
          continue;
        }
        out.push({ score, result, category, recordedAt });
      } catch {
        // ignore malformed entries
      }
    }
    return out;
  }

  private async readSemanticConfig(client: Valkey, prefix: string): Promise<SemanticConfig> {
    const raw = (await client.hgetall(`${prefix}:__config`)) ?? {};
    const defaultThreshold = Number(raw.default_threshold);
    const uncertaintyBand = Number(raw.uncertainty_band);
    const categoryThresholdsRaw = raw.category_thresholds;
    let categoryThresholds: Record<string, number> = {};
    if (typeof categoryThresholdsRaw === 'string' && categoryThresholdsRaw.length > 0) {
      try {
        const parsed = JSON.parse(categoryThresholdsRaw) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number') {
            categoryThresholds[k] = v;
          }
        }
      } catch {
        categoryThresholds = {};
      }
    }
    return {
      default_threshold: Number.isFinite(defaultThreshold)
        ? defaultThreshold
        : DEFAULT_SEMANTIC_THRESHOLD,
      uncertainty_band: Number.isFinite(uncertaintyBand)
        ? uncertaintyBand
        : DEFAULT_UNCERTAINTY_BAND,
      category_thresholds: categoryThresholds,
    };
  }

  private async readToolPolicyTtl(
    client: Valkey,
    prefix: string,
    toolName: string,
  ): Promise<number | null> {
    const policiesKey = `${prefix}:__tool_policies`;
    const raw = await client.hget(policiesKey, toolName);
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { ttl?: unknown };
      return typeof parsed.ttl === 'number' ? parsed.ttl : null;
    } catch {
      return null;
    }
  }

  private extractAgentToolStats(
    raw: Record<string, string>,
  ): Record<string, { hits: number; misses: number; costSavedMicros: number }> {
    const out: Record<string, { hits: number; misses: number; costSavedMicros: number }> = {};
    const pattern = /^tool:([^:]+):(hits|misses|cost_saved_micros)$/;
    for (const [key, value] of Object.entries(raw)) {
      const match = key.match(pattern);
      if (match === null) {
        continue;
      }
      const toolName = match[1];
      if (out[toolName] === undefined) {
        out[toolName] = { hits: 0, misses: 0, costSavedMicros: 0 };
      }
      const numValue = parseInt(value, 10);
      if (Number.isNaN(numValue)) {
        continue;
      }
      if (match[2] === 'hits') {
        out[toolName].hits = numValue;
      } else if (match[2] === 'misses') {
        out[toolName].misses = numValue;
      } else {
        out[toolName].costSavedMicros = numValue;
      }
    }
    return out;
  }

  private computeCategoryBreakdown(
    samples: Array<{ score: number; result: 'hit' | 'miss'; category: string }>,
  ): Array<{ category: string; hit_rate: number; ops: number }> {
    const grouped: Record<string, { hits: number; misses: number }> = {};
    for (const sample of samples) {
      if (grouped[sample.category] === undefined) {
        grouped[sample.category] = { hits: 0, misses: 0 };
      }
      if (sample.result === 'hit') {
        grouped[sample.category].hits += 1;
      } else {
        grouped[sample.category].misses += 1;
      }
    }
    return Object.entries(grouped)
      .map(([category, s]) => ({
        category,
        hit_rate: s.hits + s.misses === 0 ? 0 : s.hits / (s.hits + s.misses),
        ops: s.hits + s.misses,
      }))
      .sort((a, b) => b.ops - a.ops);
  }

  private deriveSemanticWarnings(
    hitRate: number,
    uncertainHitRate: number,
    total: number,
  ): CacheHealthWarning[] {
    const warnings: CacheHealthWarning[] = [];
    if (total < 100) {
      warnings.push({
        level: 'info',
        message: 'Fewer than 100 operations recorded — most metrics will be unreliable.',
      });
    }
    if (total >= 100 && hitRate < 0.2) {
      warnings.push({
        level: 'warn',
        message: `Hit rate ${(hitRate * 100).toFixed(1)}% is low; consider loosening the threshold or improving prompt normalization.`,
      });
    }
    if (uncertainHitRate > 0.25) {
      warnings.push({
        level: 'warn',
        message: `${(uncertainHitRate * 100).toFixed(1)}% of hits are in the uncertainty band — review tightening the threshold.`,
      });
    }
    return warnings;
  }

  private deriveAgentWarnings(totalHits: number, total: number): CacheHealthWarning[] {
    const warnings: CacheHealthWarning[] = [];
    if (total < 100) {
      warnings.push({
        level: 'info',
        message: 'Fewer than 100 operations recorded — metrics will be unreliable.',
      });
    }
    const hitRate = total === 0 ? 0 : totalHits / total;
    if (total >= 100 && hitRate < 0.3) {
      warnings.push({
        level: 'warn',
        message: `Aggregate hit rate ${(hitRate * 100).toFixed(1)}% is low; review per-tool TTLs.`,
      });
    }
    return warnings;
  }

  private getClient(connectionId: string): ReturnType<DatabasePort['getClient']> {
    return this.registry.get(connectionId).getClient();
  }
}
