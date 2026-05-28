import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { StoredCacheProposal } from '@betterdb/shared';
import { SEMANTIC_CACHE } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { CacheResolverService } from './cache-resolver.service';
import type { TuningMetricsSnapshot } from './cache-readonly.types';

/**
 * Post-apply outcome evaluator for threshold proposals.
 *
 * Runs on a periodic interval (default: 2 minutes). On each tick it finds
 * applied threshold_adjust proposals that:
 *   1. Were applied at least EVALUATION_WINDOW_MS ago (default: 15 minutes)
 *   2. Have not yet been evaluated (no `outcome_evaluation` in applied_result.details)
 *
 * For each, it reads the current similarity window metrics and compares
 * against the metrics snapshot stored in __tuning_history at apply time.
 * The verdict (improved / degraded / neutral) is written back to
 * applied_result.details.outcome_evaluation and an audit trail entry is appended.
 *
 * The recommendation engine reads these verdicts to weight future signals:
 * if past tighten proposals consistently degraded a cache, the tighten
 * signal is dampened.
 */

const DEFAULT_TICK_INTERVAL_MS = 2 * 60 * 1000;  // 2 minutes
const DEFAULT_EVALUATION_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes after apply

// Override via env for testing: OUTCOME_EVAL_WINDOW_MS=5000 OUTCOME_EVAL_TICK_MS=2000
const ENV_TICK_MS = Number(process.env.OUTCOME_EVAL_TICK_MS);
const ENV_WINDOW_MS = Number(process.env.OUTCOME_EVAL_WINDOW_MS);

const IMPROVEMENT_THRESHOLD = 0.10;  // 10% improvement = "improved"
const DEGRADATION_THRESHOLD = 0.10;  // 10% worse = "degraded"

export interface OutcomeEvaluation {
  verdict: 'improved' | 'degraded' | 'neutral';
  evaluated_at: number;
  window_ms: number;
  signal: string;
  before: TuningMetricsSnapshot;
  after: TuningMetricsSnapshot;
  detail: string;
}

@Injectable()
export class CacheOutcomeEvaluator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheOutcomeEvaluator.name);
  private timer: NodeJS.Timeout | null = null;
  private tickIntervalMs = Number.isFinite(ENV_TICK_MS) && ENV_TICK_MS > 0 ? ENV_TICK_MS : DEFAULT_TICK_INTERVAL_MS;
  private evaluationWindowMs = Number.isFinite(ENV_WINDOW_MS) && ENV_WINDOW_MS > 0 ? ENV_WINDOW_MS : DEFAULT_EVALUATION_WINDOW_MS;
  private now: () => number = Date.now;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly registry: ConnectionRegistry,
    private readonly resolver: CacheResolverService,
  ) {}

  configureForTesting(options: {
    tickIntervalMs?: number;
    evaluationWindowMs?: number;
    now?: () => number;
  }): void {
    if (options.tickIntervalMs !== undefined) this.tickIntervalMs = options.tickIntervalMs;
    if (options.evaluationWindowMs !== undefined) this.evaluationWindowMs = options.evaluationWindowMs;
    if (options.now !== undefined) this.now = options.now;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error(
          `Outcome evaluation tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.tickIntervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<number> {
    const connections = await this.storage.getConnections();
    let evaluated = 0;

    for (const conn of connections) {
      try {
        const proposals = await this.storage.listCacheProposals({
          connection_id: conn.id,
          status: 'applied',
          proposal_type: 'threshold_adjust',
          limit: 50,
        });

        for (const proposal of proposals) {
          const result = await this.evaluateProposal(proposal);
          if (result) evaluated += 1;
        }
      } catch (err) {
        this.logger.warn(
          `Failed to evaluate proposals for connection ${conn.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (evaluated > 0) {
      this.logger.log(`Evaluated ${evaluated} proposal outcome(s)`);
    }
    return evaluated;
  }

  private async evaluateProposal(proposal: StoredCacheProposal): Promise<OutcomeEvaluation | null> {
    // Skip if not a threshold_adjust or not semantic_cache
    if (proposal.proposal_type !== 'threshold_adjust' || proposal.cache_type !== SEMANTIC_CACHE) {
      return null;
    }

    // Skip if not yet past the evaluation window
    const appliedAt = proposal.applied_at;
    if (appliedAt === null || appliedAt === undefined) return null;
    const elapsed = this.now() - appliedAt;
    if (elapsed < this.evaluationWindowMs) return null;

    // Skip if already evaluated
    const details = proposal.applied_result?.details as Record<string, unknown> | undefined;
    if (details?.outcome_evaluation) return null;

    // Resolve the cache to get its prefix
    const cache = await this.resolver.resolveCacheByName(proposal.connection_id, proposal.cache_name);
    if (!cache) return null;

    // Read the tuning history to get the "before" snapshot
    let client: any;
    try {
      client = this.registry.get(proposal.connection_id).getClient();
    } catch {
      return null;  // Connection no longer active
    }

    const historyKey = `${cache.prefix}:__tuning_history`;
    let historyEntries: Array<{ signal?: string; metrics?: TuningMetricsSnapshot; to?: number }> = [];
    try {
      const raw = (await client.lrange(historyKey, 0, 9)) as string[];
      for (const item of raw) {
        try {
          historyEntries.push(JSON.parse(item));
        } catch { /* skip */ }
      }
    } catch {
      return null;  // Can't read history
    }

    // Find the history entry matching this proposal's target threshold
    const targetThreshold = proposal.proposal_payload.new_threshold;
    const historyEntry = historyEntries.find(
      (e) => e.to !== undefined && Math.abs(e.to - targetThreshold) < 0.001,
    );
    if (!historyEntry?.metrics || !historyEntry.signal) return null;

    // Compute current metrics from similarity window entries recorded AFTER
    // the proposal was applied. Pre-adjustment entries have hit/miss labels
    // based on the old threshold and would contaminate the metrics.
    const currentMetrics = await this.computeCurrentMetrics(client, cache.prefix, targetThreshold, appliedAt);
    if (!currentMetrics) return null;

    // Compare before vs after
    const evaluation = this.compareMetrics(
      historyEntry.signal,
      historyEntry.metrics,
      currentMetrics,
    );

    // Write the evaluation back to the proposal
    const updatedDetails = {
      ...(details ?? {}),
      outcome_evaluation: evaluation,
    };
    const updatedResult = {
      ...proposal.applied_result!,
      details: updatedDetails,
    };

    try {
      await this.storage.updateCacheProposalStatus({
        id: proposal.id,
        expected_status: ['applied'],
        status: 'applied',  // Keep the same status
        applied_at: proposal.applied_at,
        applied_result: updatedResult,
      });

      await this.storage.appendCacheProposalAudit({
        id: randomUUID(),
        proposal_id: proposal.id,
        event_type: 'outcome_evaluated',
        event_payload: { outcome_evaluation: evaluation },
        event_at: this.now(),
        actor: 'system',
        actor_source: 'system',
      });
    } catch (err) {
      this.logger.warn(
        `Failed to write outcome evaluation for proposal ${proposal.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    this.logger.log(
      `Proposal ${proposal.id} (${proposal.cache_name}): ${evaluation.verdict} — ${evaluation.detail}`,
    );
    return evaluation;
  }

  private compareMetrics(
    signal: string,
    before: TuningMetricsSnapshot,
    after: TuningMetricsSnapshot,
  ): OutcomeEvaluation {
    const base: Omit<OutcomeEvaluation, 'verdict' | 'detail'> = {
      evaluated_at: this.now(),
      window_ms: this.evaluationWindowMs,
      signal,
      before,
      after,
    };

    // Compare the metric that the triggering signal targets
    let beforeValue: number;
    let afterValue: number;
    let lowerIsBetter: boolean;

    switch (signal) {
      case 'uncertain_hits':
        beforeValue = before.uncertain_hit_rate;
        afterValue = after.uncertain_hit_rate;
        lowerIsBetter = true;
        break;
      case 'distant_hits':
        beforeValue = before.distant_hit_rate;
        afterValue = after.distant_hit_rate;
        lowerIsBetter = true;
        break;
      case 'near_misses':
        beforeValue = before.near_miss_rate;
        afterValue = after.near_miss_rate;
        lowerIsBetter = true;
        break;
      case 'low_hit_rate':
        beforeValue = before.hit_rate;
        afterValue = after.hit_rate;
        lowerIsBetter = false;
        break;
      default:
        return {
          ...base,
          verdict: 'neutral',
          detail: `Unknown signal "${signal}" — cannot evaluate`,
        };
    }

    const pctChange = beforeValue === 0
      ? (afterValue === 0 ? 0 : 1)
      : (afterValue - beforeValue) / beforeValue;

    const improved = lowerIsBetter
      ? pctChange < -IMPROVEMENT_THRESHOLD
      : pctChange > IMPROVEMENT_THRESHOLD;

    const degraded = lowerIsBetter
      ? pctChange > DEGRADATION_THRESHOLD
      : pctChange < -DEGRADATION_THRESHOLD;

    const fmtPct = (v: number): string => `${(v * 100).toFixed(1)}%`;

    if (improved) {
      return {
        ...base,
        verdict: 'improved',
        detail: `${signal}: ${fmtPct(beforeValue)} → ${fmtPct(afterValue)} (${fmtPct(Math.abs(pctChange))} improvement)`,
      };
    }
    if (degraded) {
      return {
        ...base,
        verdict: 'degraded',
        detail: `${signal}: ${fmtPct(beforeValue)} → ${fmtPct(afterValue)} (${fmtPct(Math.abs(pctChange))} degradation)`,
      };
    }
    return {
      ...base,
      verdict: 'neutral',
      detail: `${signal}: ${fmtPct(beforeValue)} → ${fmtPct(afterValue)} (within ±${fmtPct(IMPROVEMENT_THRESHOLD)} band)`,
    };
  }

  private async computeCurrentMetrics(
    client: any,
    prefix: string,
    threshold: number,
    sinceMs: number = 0,
  ): Promise<TuningMetricsSnapshot | null> {
    const DEFAULT_UNCERTAINTY_BAND = 0.05;

    // The similarity window is a ZSET scored by timestamp (epoch ms).
    // When sinceMs > 0, only read entries recorded after the proposal was
    // applied so pre-adjustment hit/miss classifications don't contaminate
    // the metrics.
    let raw: Array<string | number>;
    try {
      if (sinceMs > 0) {
        raw = (await client.zrangebyscore(
          `${prefix}:__similarity_window`, String(sinceMs), '+inf', 'WITHSCORES',
        )) as Array<string | number>;
      } else {
        raw = (await client.zrange(
          `${prefix}:__similarity_window`, '0', '-1', 'WITHSCORES',
        )) as Array<string | number>;
      }
    } catch {
      return null;
    }

    let uncertaintyBand = DEFAULT_UNCERTAINTY_BAND;
    try {
      const configRaw = await client.hget(`${prefix}:__config`, 'uncertainty_band');
      if (configRaw) {
        const parsed = Number(configRaw);
        if (Number.isFinite(parsed)) uncertaintyBand = parsed;
      }
    } catch { /* use default */ }

    const hits: number[] = [];
    const misses: number[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i];
      if (typeof member !== 'string') continue;
      try {
        const entry = JSON.parse(member) as { score?: number; result?: string };
        const score = typeof entry.score === 'number' ? entry.score : NaN;
        if (!Number.isFinite(score)) continue;
        if (entry.result === 'hit') hits.push(score);
        else if (entry.result === 'miss') misses.push(score);
      } catch { /* skip */ }
    }

    const total = hits.length + misses.length;
    if (total === 0) return null;

    const hitRate = hits.length / total;
    const uncertainHitRate = hits.length === 0 ? 0
      : hits.filter((s) => s >= threshold - uncertaintyBand).length / hits.length;
    const midpoint = threshold / 2;
    const distantHitRate = hits.length === 0 ? 0
      : hits.filter((s) => s > midpoint).length / hits.length;
    const nearMissRate = misses.length === 0 ? 0
      : misses.filter((s) => s > threshold && s <= threshold + uncertaintyBand).length / misses.length;

    return { hit_rate: hitRate, uncertain_hit_rate: uncertainHitRate, distant_hit_rate: distantHitRate, near_miss_rate: nearMissRate };
  }
}
