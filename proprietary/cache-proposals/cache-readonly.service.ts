import { Inject, Injectable, Logger } from '@nestjs/common';
import type Valkey from 'iovalkey';
import type { CacheType, StoredCacheProposal } from '@betterdb/shared';
import { AGENT_CACHE, REGISTRY_KEY, SEMANTIC_CACHE, heartbeatKeyFor } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { CacheResolverService, type ResolvedCache } from './cache-resolver.service';
import { CacheNotFoundError, InvalidCacheTypeError } from './errors';
import { readIntField } from '@app/common/utils/record-fields';
import {
  THRESHOLD_RECOMMENDATIONS,
  THRESHOLD_REASONINGS,
  TOOL_EFFECTIVENESS_RECOMMENDATIONS,
} from './cache-readonly.types';
import type {
  CacheHealth,
  CacheHealthWarning,
  CacheListEntry,
  SimilarityDistribution,
  SimilarityDistributionBucket,
  ThresholdRecommendation,
  ThresholdRecommendationConfidenceBreakdown,
  ThresholdRecommendationKind,
  ToolEffectivenessEntry,
  ToolEffectivenessRecommendation,
  TuningHistoryEntry,
  TuningMetricsSnapshot,
} from './cache-readonly.types';
import { DatabasePort } from '@app/common/interfaces/database-port.interface';
import {
  computeConfidence,
  TIGHTEN_BOUNDARY,
  LOOSEN_BOUNDARY,
} from './confidence-score';

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

// Recall-cost guard: if tightening would lose more than this fraction of
// current hits, the TP/FP distributions overlap too much for threshold
// adjustment to help — suggest a qualitative improvement instead.
const RECALL_COST_MAX = 0.15;

// Velocity dampening: prevent runaway tightening/loosening and oscillation.
const TUNING_HISTORY_KEY_SUFFIX = ':__tuning_history';
const TUNING_HISTORY_MAX_ENTRIES = 10;
// After this many consecutive same-direction adjustments, declare optimal.
const VELOCITY_CAP_CONSECUTIVE = 5;
// After this many direction flips in the history window, declare optimal.
const OSCILLATION_CAP_FLIPS = 3;

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
      const stats = await this.readBaseStats(client, marker.prefix);
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
      const hits = readIntField(raw, 'hits');
      const misses = readIntField(raw, 'misses');
      const total = readIntField(raw, 'total') || hits + misses;
      const costSavedMicros = readIntField(raw, 'cost_saved_micros');
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

    const llmHits = readIntField(raw, 'llm:hits');
    const llmMisses = readIntField(raw, 'llm:misses');
    const toolHits = readIntField(raw, 'tool:hits');
    const toolMisses = readIntField(raw, 'tool:misses');
    const totalHits = llmHits + toolHits;
    const totalMisses = llmMisses + toolMisses;
    const total = totalHits + totalMisses;
    const costSavedMicros = readIntField(raw, 'cost_saved_micros');
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
        recommendation: THRESHOLD_RECOMMENDATIONS.INSUFFICIENT_DATA,
        reasoning: THRESHOLD_REASONINGS.insufficientData(sampleCount, minSamples),
        confidence_score: null,
        confidence_breakdown: null,
      };
    }
    const hits = filtered.filter((s) => s.result === 'hit');
    const misses = filtered.filter((s) => s.result === 'miss');
    const hitRate = hits.length / sampleCount;

    // Tighten signal 1: hits near the threshold boundary (uncertainty band)
    const uncertainHits = hits.filter((s) => s.score >= threshold - config.uncertainty_band);
    const uncertainHitRate = hits.length === 0 ? 0 : uncertainHits.length / hits.length;

    // Tighten signal 2: "distant hits" — matches in the upper half of [0, threshold].
    // These are confident (not in the uncertainty band) but far from a perfect match.
    // A high ratio means the threshold is catching many weak matches that are likely
    // false positives. This catches the blind spot where the old algorithm said
    // "optimal" at threshold 0.45 with 99% hit rate and 53% precision.
    const midpoint = threshold / 2;
    const distantHits = hits.filter((s) => s.score > midpoint);
    const distantHitRate = hits.length === 0 ? 0 : distantHits.length / hits.length;

    // Loosen signal: near-misses (misses just above the threshold).
    // Window widened from fixed 0.03 to uncertainty_band for better sensitivity.
    const nearMisses = misses.filter(
      (s) => s.score > threshold && s.score <= threshold + config.uncertainty_band,
    );
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
    let signal: string | undefined;

    const currentMetrics = {
      hit_rate: hitRate,
      uncertain_hit_rate: uncertainHitRate,
      distant_hit_rate: distantHitRate,
      near_miss_rate: nearMissRate,
    };

    if (uncertainHitRate > 0.2) {
      // Many hits at the threshold boundary — but weigh against overall hit rate.
      // A 20% uncertain-hit rate with 70% overall hits means 14% of all ops are
      // uncertain — that's noise, not a strong signal. Only tighten when the
      // uncertain fraction of ALL operations (not just hits) is meaningful.
      const uncertainFractionOfAll = uncertainHitRate * hitRate;
      if (uncertainFractionOfAll > 0.15) {
        recommendation = THRESHOLD_RECOMMENDATIONS.TIGHTEN;
        signal = 'uncertain_hits';
        const step = config.uncertainty_band * 0.6;
        recommendedThreshold = Math.max(0, threshold - step);
        reasoning = THRESHOLD_REASONINGS.tighten(uncertainHitRate);
      } else {
        recommendation = THRESHOLD_RECOMMENDATIONS.OPTIMAL;
        reasoning = THRESHOLD_REASONINGS.optimal(hitRate, uncertainHitRate);
      }
    } else if (distantHitRate > 0.25 && hits.length >= 20) {
      // >25% of hits are weak matches (score in upper half of acceptance range).
      // But if the hit rate is moderate (< 80%), the score distribution is
      // naturally spread out — distant hits aren't necessarily false positives.
      // Only tighten when the cache is hitting on almost everything (high hit rate),
      // which means it's too loose and catching junk.
      if (hitRate > 0.8) {
        // Use the 75th percentile of hit scores as the target — this cuts the tail
        // of questionable matches while preserving strong ones. Cap the step at
        // 2× uncertainty_band to avoid overshooting on the first cycle.
        recommendation = THRESHOLD_RECOMMENDATIONS.TIGHTEN;
        signal = 'distant_hits';
        const sortedHitScores = hits.map((s) => s.score).sort((a, b) => a - b);
        const p75 = sortedHitScores[Math.floor(sortedHitScores.length * 0.75)];
        const target = p75 + config.uncertainty_band * 0.3;
        const maxStep = config.uncertainty_band * 2;
        recommendedThreshold = Math.min(threshold, Math.max(threshold - maxStep, Math.max(0, target)));
        reasoning = THRESHOLD_REASONINGS.tightenDistantHits(distantHitRate, hitRate);
      } else {
        recommendation = THRESHOLD_RECOMMENDATIONS.OPTIMAL;
        reasoning = THRESHOLD_REASONINGS.optimal(hitRate, uncertainHitRate);
      }
    } else if (nearMissRate > 0.25) {
      // Many near-misses just above the threshold — probably too strict.
      recommendation = THRESHOLD_RECOMMENDATIONS.LOOSEN;
      signal = 'near_misses';
      recommendedThreshold = threshold + avgNearMissDelta;
      reasoning = THRESHOLD_REASONINGS.loosen(nearMissRate);
    } else if (hitRate < 0.05 && misses.length >= 20) {
      // Very few hits with enough data — threshold may be too strict.
      // Check if there are misses close to the threshold that would become hits.
      const closeMisses = misses.filter(
        (s) => s.score > threshold && s.score <= threshold + config.uncertainty_band * 2,
      );
      if (closeMisses.length / misses.length > 0.1) {
        recommendation = THRESHOLD_RECOMMENDATIONS.LOOSEN;
        signal = 'low_hit_rate';
        const step = config.uncertainty_band * 0.6;
        recommendedThreshold = threshold + step;
        reasoning = THRESHOLD_REASONINGS.loosenLowHitRate(hitRate);
      } else {
        recommendation = THRESHOLD_RECOMMENDATIONS.OPTIMAL;
        reasoning = THRESHOLD_REASONINGS.optimal(hitRate, uncertainHitRate);
      }
    } else {
      recommendation = THRESHOLD_RECOMMENDATIONS.OPTIMAL;
      reasoning = THRESHOLD_REASONINGS.optimal(hitRate, uncertainHitRate);
    }

    // --- Recall-cost guard ---
    // Before committing to a tighten, estimate how many current hits would be
    // lost at the proposed new threshold. If the recall cost is too high, the
    // TP/FP distributions overlap too much for threshold adjustment alone to
    // help — declare optimal and suggest a qualitative improvement.
    if (
      recommendation === THRESHOLD_RECOMMENDATIONS.TIGHTEN &&
      recommendedThreshold !== undefined &&
      hits.length > 0
    ) {
      const hitsLost = hits.filter((s) => s.score > recommendedThreshold! && s.score <= threshold).length;
      const recallCost = hitsLost / hits.length;
      if (recallCost > RECALL_COST_MAX) {
        recommendation = THRESHOLD_RECOMMENDATIONS.OPTIMAL;
        recommendedThreshold = undefined;
        signal = undefined;
        reasoning = THRESHOLD_REASONINGS.recallCostTooHigh(recallCost);
      }
    }

    // --- Outcome tracking + velocity dampening ---
    // Only applies to actionable recommendations (tighten/loosen).
    let dampeningFactor: number | undefined;
    let consecutiveSameDirection: number | undefined;
    if (
      recommendation === THRESHOLD_RECOMMENDATIONS.TIGHTEN ||
      recommendation === THRESHOLD_RECOMMENDATIONS.LOOSEN
    ) {
      const direction = recommendation === THRESHOLD_RECOMMENDATIONS.TIGHTEN ? 'tighten' : 'loosen';
      const history = await this.readTuningHistory(client, cache.prefix);

      // Outcome check: did the last adjustment actually improve the signal it targeted?
      // If not, further movement in the same direction is unlikely to help.
      const outcomeCheck = this.checkLastOutcome(history, direction, currentMetrics);
      if (outcomeCheck.ineffective) {
        recommendation = THRESHOLD_RECOMMENDATIONS.OPTIMAL;
        recommendedThreshold = undefined;
        reasoning = outcomeCheck.reason!;
      } else {
        // Velocity dampening (backstop): reduce step sizes for consecutive same-direction
        // adjustments, or cap to optimal on oscillation.
        const dampening = this.computeDampening(history, direction);
        dampeningFactor = dampening.factor;
        consecutiveSameDirection = dampening.consecutiveSameDirection;

        if (dampening.capped) {
          recommendation = THRESHOLD_RECOMMENDATIONS.OPTIMAL;
          recommendedThreshold = undefined;
          reasoning = dampening.reason!;
        } else if (dampening.factor < 1 && recommendedThreshold !== undefined) {
          const originalStep = Math.abs(recommendedThreshold - threshold);
          const dampenedStep = originalStep * dampening.factor;
          recommendedThreshold =
            direction === 'tighten'
              ? Math.max(0, threshold - dampenedStep)
              : threshold + dampenedStep;
        }
      }
    }

    let confidence_score: number | null = null;
    let confidence_breakdown: ThresholdRecommendationConfidenceBreakdown | null = null;
    if (
      recommendation === THRESHOLD_RECOMMENDATIONS.TIGHTEN ||
      recommendation === THRESHOLD_RECOMMENDATIONS.LOOSEN
    ) {
      const isTighten = recommendation === THRESHOLD_RECOMMENDATIONS.TIGHTEN;
      const latestRecordedAt = filtered.reduce(
        (acc, s) => (s.recordedAt > acc ? s.recordedAt : acc),
        0,
      );
      const result = computeConfidence({
        sampleCount,
        signalRate: isTighten ? uncertainHitRate : nearMissRate,
        signalBoundary: isTighten ? TIGHTEN_BOUNDARY : LOOSEN_BOUNDARY,
        latestRecordedAt,
        now: Date.now(),
      });
      confidence_score = result.score;
      confidence_breakdown = result.breakdown;
      this.logger.log(
        `thresholdRecommendation ${recommendation} cache=${cache.name} ` +
          `category=${categoryLabel} score=${confidence_score.toFixed(3)} ` +
          `sample=${result.breakdown.sample.toFixed(3)} ` +
          `signal=${result.breakdown.signal.toFixed(3)} ` +
          `freshness=${result.breakdown.freshness.toFixed(3)}`,
      );
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
      signal,
      metrics_snapshot: currentMetrics,
      dampening_factor: dampeningFactor,
      consecutive_same_direction: consecutiveSameDirection,
      confidence_score,
      confidence_breakdown,
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
        recommendation =
          policyTtl !== null && policyTtl < 3600
            ? TOOL_EFFECTIVENESS_RECOMMENDATIONS.INCREASE_TTL
            : TOOL_EFFECTIVENESS_RECOMMENDATIONS.OPTIMAL;
      } else if (hitRate >= 0.4) {
        recommendation = TOOL_EFFECTIVENESS_RECOMMENDATIONS.OPTIMAL;
      } else {
        recommendation = TOOL_EFFECTIVENESS_RECOMMENDATIONS.DECREASE_TTL_OR_DISABLE;
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
      readIntField(raw, 'hits') + readIntField(raw, 'llm:hits') + readIntField(raw, 'tool:hits');
    const misses =
      readIntField(raw, 'misses') + readIntField(raw, 'llm:misses') + readIntField(raw, 'tool:misses');
    const explicitTotal = readIntField(raw, 'total');
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

  private async readTuningHistory(client: Valkey, prefix: string): Promise<TuningHistoryEntry[]> {
    const key = `${prefix}${TUNING_HISTORY_KEY_SUFFIX}`;
    let raw: string[];
    try {
      raw = (await client.lrange(key, 0, TUNING_HISTORY_MAX_ENTRIES - 1)) as string[];
    } catch {
      return [];
    }
    const entries: TuningHistoryEntry[] = [];
    for (const item of raw) {
      try {
        const parsed = JSON.parse(item) as TuningHistoryEntry;
        if (parsed.d && typeof parsed.from === 'number' && typeof parsed.to === 'number') {
          entries.push(parsed);
        }
      } catch {
        // ignore malformed entries
      }
    }
    return entries;
  }

  private computeDampening(
    history: TuningHistoryEntry[],
    currentDirection: 'tighten' | 'loosen',
  ): { factor: number; consecutiveSameDirection: number; directionFlips: number; capped: boolean; reason?: string } {
    if (history.length === 0) {
      return { factor: 1, consecutiveSameDirection: 0, directionFlips: 0, capped: false };
    }

    // Count consecutive same-direction entries at the head (most recent first).
    let consecutiveSameDirection = 0;
    for (const entry of history) {
      if (entry.d === currentDirection) {
        consecutiveSameDirection += 1;
      } else {
        break;
      }
    }

    // Count direction flips in the full history window.
    let directionFlips = 0;
    for (let i = 1; i < history.length; i++) {
      if (history[i].d !== history[i - 1].d) {
        directionFlips += 1;
      }
    }
    // Also count a flip if the current direction differs from the most recent entry.
    if (history.length > 0 && history[0].d !== currentDirection) {
      directionFlips += 1;
    }

    // Cap: too many consecutive same-direction adjustments.
    if (consecutiveSameDirection >= VELOCITY_CAP_CONSECUTIVE) {
      return {
        factor: 0,
        consecutiveSameDirection,
        directionFlips,
        capped: true,
        reason: THRESHOLD_REASONINGS.velocityDampened(consecutiveSameDirection, currentDirection),
      };
    }

    // Cap: oscillation (too many direction flips).
    if (directionFlips >= OSCILLATION_CAP_FLIPS) {
      return {
        factor: 0,
        consecutiveSameDirection,
        directionFlips,
        capped: true,
        reason: THRESHOLD_REASONINGS.oscillationDetected(directionFlips),
      };
    }

    // Progressive dampening: 1/(1 + n*0.5) where n = consecutive same-direction.
    // n=0 → 1.0, n=1 → 0.67, n=2 → 0.50, n=3 → 0.40, n=4 → 0.33
    const factor = 1 / (1 + consecutiveSameDirection * 0.5);
    return { factor, consecutiveSameDirection, directionFlips, capped: false };
  }

  /**
   * Outcome tracking: check whether the most recent adjustment in the same
   * direction actually improved the signal that triggered it.  If the signal
   * level is the same or worse, further movement in that direction is unlikely
   * to help.
   */
  private checkLastOutcome(
    history: TuningHistoryEntry[],
    currentDirection: 'tighten' | 'loosen',
    currentMetrics: TuningMetricsSnapshot,
  ): { ineffective: boolean; reason?: string } {
    // Find the most recent entry in the same direction that has a metrics snapshot.
    const lastSame = history.find((e) => e.d === currentDirection && e.metrics);
    if (!lastSame?.metrics || !lastSame.signal) {
      // No prior snapshot to compare against — allow the adjustment.
      return { ineffective: false };
    }

    // Map signal names to the metric they target.
    // For tighten signals: the metric should decrease after tightening.
    // For loosen signals: the metric should decrease (near_miss_rate) or
    //   increase (hit_rate) after loosening.
    const before = lastSame.metrics;
    const signalName = lastSame.signal;
    let improved: boolean;
    let beforeValue: number;
    let afterValue: number;

    switch (signalName) {
      case 'uncertain_hits':
        beforeValue = before.uncertain_hit_rate;
        afterValue = currentMetrics.uncertain_hit_rate;
        // Tightening should reduce uncertain hit rate.
        improved = afterValue < beforeValue * 0.8; // require 20% improvement
        break;
      case 'distant_hits':
        beforeValue = before.distant_hit_rate;
        afterValue = currentMetrics.distant_hit_rate;
        // Tightening should reduce distant hit rate.
        improved = afterValue < beforeValue * 0.8;
        break;
      case 'near_misses':
        beforeValue = before.near_miss_rate;
        afterValue = currentMetrics.near_miss_rate;
        // Loosening should reduce near miss rate.
        improved = afterValue < beforeValue * 0.8;
        break;
      case 'low_hit_rate':
        beforeValue = before.hit_rate;
        afterValue = currentMetrics.hit_rate;
        // Loosening should increase hit rate.
        improved = afterValue > beforeValue * 1.2; // require 20% improvement
        break;
      default:
        return { ineffective: false };
    }

    if (!improved) {
      return {
        ineffective: true,
        reason: THRESHOLD_REASONINGS.adjustmentIneffective(
          currentDirection,
          signalName,
          beforeValue,
          afterValue,
        ),
      };
    }
    return { ineffective: false };
  }

  private async readSemanticConfig(client: Valkey, prefix: string): Promise<SemanticConfig> {
    const raw = (await client.hgetall(`${prefix}:__config`)) ?? {};
    // The semantic-cache library writes `threshold` to __config (via configRefresh
    // and proposal approval), while the discovery marker uses `default_threshold`.
    // Read both, preferring `threshold` (the live/approved value).
    const defaultThreshold = Number(raw.threshold ?? raw.default_threshold);
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
