import { Injectable, Logger } from '@nestjs/common';
import {
  AGENT_CACHE,
  SEMANTIC_CACHE,
  type AgentInvalidatePayload,
  type AgentToolTtlAdjustPayload,
  type SemanticInvalidatePayload,
  type SemanticThresholdAdjustPayload,
  type StoredCacheProposal,
} from '@betterdb/shared';
import type Valkey from 'iovalkey';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { CacheResolverService, type ResolvedCache } from './cache-resolver.service';
import { ApplyFailedError } from './errors';
import type { TuningMetricsSnapshot } from './cache-readonly.types';
import { computeMetricsFromSimilarityWindow } from './similarity-metrics.utils';

const FT_SEARCH_LIMIT = 1000;
const TUNING_HISTORY_KEY_SUFFIX = ':__tuning_history';
const TUNING_HISTORY_MAX_ENTRIES = 10;

export interface ApplyOutcome {
  actualAffected?: number;
  durationMs: number;
  details: Record<string, unknown>;
}

@Injectable()
export class CacheApplyDispatcher {
  private readonly logger = new Logger(CacheApplyDispatcher.name);

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly resolver: CacheResolverService,
  ) {}

  async dispatch(proposal: StoredCacheProposal): Promise<ApplyOutcome> {
    const cache = await this.resolver.resolveCacheByName(
      proposal.connection_id,
      proposal.cache_name,
    );
    if (cache === null) {
      throw new ApplyFailedError(
        proposal.id,
        `Cache '${proposal.cache_name}' is not registered in discovery markers`,
        { reason: 'cache_not_found' },
      );
    }
    if (cache.type !== proposal.cache_type) {
      throw new ApplyFailedError(
        proposal.id,
        `Cache type changed since proposal creation (was ${proposal.cache_type}, is ${cache.type})`,
        { reason: 'cache_type_mismatch' },
      );
    }

    const adapter = this.registry.get(proposal.connection_id);
    const client = adapter.getClient() as Valkey;
    const startedAt = Date.now();

    if (proposal.cache_type === SEMANTIC_CACHE && proposal.proposal_type === 'threshold_adjust') {
      const out = await this.applySemanticThresholdAdjust(
        client,
        cache,
        proposal.proposal_payload,
        proposal.id,
      );
      return { ...out, durationMs: Date.now() - startedAt };
    }

    if (proposal.cache_type === AGENT_CACHE && proposal.proposal_type === 'tool_ttl_adjust') {
      const out = await this.applyAgentToolTtlAdjust(
        client,
        cache,
        proposal.proposal_payload,
        proposal.id,
      );
      return { ...out, durationMs: Date.now() - startedAt };
    }

    if (proposal.cache_type === SEMANTIC_CACHE && proposal.proposal_type === 'invalidate') {
      const out = await this.applySemanticInvalidate(
        client,
        cache,
        proposal.proposal_payload,
        proposal.id,
      );
      return { ...out, durationMs: Date.now() - startedAt };
    }

    if (proposal.cache_type === AGENT_CACHE && proposal.proposal_type === 'invalidate') {
      const out = await this.applyAgentInvalidate(
        client,
        cache,
        proposal.proposal_payload,
        proposal.id,
      );
      return { ...out, durationMs: Date.now() - startedAt };
    }

    const exhaustive: { id: string; cache_type: string; proposal_type: string } = proposal;
    throw new ApplyFailedError(
      exhaustive.id,
      `Unsupported (cache_type, proposal_type) combination: ${exhaustive.cache_type}/${exhaustive.proposal_type}`,
      {
        reason: 'unsupported_combination',
        cacheType: exhaustive.cache_type,
        proposalType: exhaustive.proposal_type,
      },
    );
  }

  private async applySemanticThresholdAdjust(
    client: Valkey,
    cache: ResolvedCache,
    payload: SemanticThresholdAdjustPayload,
    proposalId: string,
  ): Promise<Omit<ApplyOutcome, 'durationMs'>> {
    if (!cache.capabilities.includes('threshold_adjust')) {
      throw new ApplyFailedError(
        proposalId,
        `Cache '${cache.name}' does not advertise 'threshold_adjust' capability — it cannot read runtime threshold overrides`,
        { reason: 'capability_missing', cacheName: cache.name },
      );
    }
    const configKey = `${cache.prefix}:__config`;
    const field = payload.category === null
      ? 'threshold'
      : `threshold:${payload.category}`;
    try {
      await client.hset(configKey, field, String(payload.new_threshold));
    } catch (err) {
      throw new ApplyFailedError(proposalId, `HSET ${configKey} failed`, {
        reason: 'valkey_command_failed',
        cacheName: cache.name,
        underlying: err instanceof Error ? err.message : String(err),
      });
    }

    // Record the adjustment in tuning history for outcome tracking + velocity dampening.
    const direction = payload.new_threshold < payload.current_threshold ? 'tighten' : 'loosen';
    const historyKey = `${cache.prefix}${TUNING_HISTORY_KEY_SUFFIX}`;
    const snapshot = await this.computeMetricsSnapshot(client, cache.prefix, payload.current_threshold);
    const entry = JSON.stringify({
      d: direction,
      from: payload.current_threshold,
      to: payload.new_threshold,
      ts: Date.now(),
      signal: snapshot?.signal,
      metrics: snapshot?.metrics,
    });
    try {
      await client.lpush(historyKey, entry);
      await client.ltrim(historyKey, 0, TUNING_HISTORY_MAX_ENTRIES - 1);
    } catch (err) {
      // Non-fatal: dampening degrades gracefully without history.
      this.logger.warn(`Failed to write tuning history: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      details: {
        previous_value: payload.current_threshold,
        new_value: payload.new_threshold,
        category: payload.category,
        config_key: configKey,
        field,
      },
    };
  }

  /**
   * Compute a metrics snapshot from the current similarity window.
   * Used for outcome tracking: stored in the tuning history so the
   * recommendation engine can compare "before" vs "after" on the next cycle.
   */
  private async computeMetricsSnapshot(
    client: Valkey,
    prefix: string,
    threshold: number,
  ): Promise<{ signal: string; metrics: TuningMetricsSnapshot } | null> {
    const result = await computeMetricsFromSimilarityWindow(client, prefix, threshold);
    if (!result) return null;

    const { metrics, hitCount, missCount } = result;

    // Determine dominant signal (must match the recommendation engine's guards exactly).
    const uncertainFractionOfAll = metrics.uncertain_hit_rate * metrics.hit_rate;
    let signal = 'optimal';
    if (metrics.uncertain_hit_rate > 0.2 && uncertainFractionOfAll > 0.15) signal = 'uncertain_hits';
    else if (metrics.distant_hit_rate > 0.25 && hitCount >= 20 && metrics.hit_rate > 0.8) signal = 'distant_hits';
    else if (metrics.near_miss_rate > 0.25) signal = 'near_misses';
    else if (metrics.hit_rate < 0.05 && missCount >= 20) signal = 'low_hit_rate';

    return { signal, metrics };
  }

  private async applyAgentToolTtlAdjust(
    client: Valkey,
    cache: ResolvedCache,
    payload: AgentToolTtlAdjustPayload,
    proposalId: string,
  ): Promise<Omit<ApplyOutcome, 'durationMs'>> {
    const policiesKey = `${cache.prefix}:__tool_policies`;
    const policy = JSON.stringify({ ttl: payload.new_ttl_seconds });
    try {
      await client.hset(policiesKey, payload.tool_name, policy);
    } catch (err) {
      throw new ApplyFailedError(proposalId, `HSET ${policiesKey} failed`, {
        reason: 'valkey_command_failed',
        cacheName: cache.name,
        underlying: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      details: {
        previous_value: payload.current_ttl_seconds,
        new_value: payload.new_ttl_seconds,
        tool_name: payload.tool_name,
        policies_key: policiesKey,
      },
    };
  }

  private async applySemanticInvalidate(
    client: Valkey,
    cache: ResolvedCache,
    payload: SemanticInvalidatePayload,
    proposalId: string,
  ): Promise<Omit<ApplyOutcome, 'durationMs'>> {
    const indexName = `${cache.prefix}:idx`;
    let raw: unknown;
    try {
      raw = await client.call(
        'FT.SEARCH',
        indexName,
        payload.filter_expression,
        'RETURN',
        '0',
        'LIMIT',
        '0',
        String(FT_SEARCH_LIMIT),
        'DIALECT',
        '2',
      );
    } catch (err) {
      throw new ApplyFailedError(proposalId, `FT.SEARCH ${indexName} failed`, {
        reason: 'valkey_command_failed',
        cacheName: cache.name,
        underlying: err instanceof Error ? err.message : String(err),
      });
    }
    const keys = parseFtSearchKeys(raw);
    if (keys.length === 0) {
      return {
        actualAffected: 0,
        details: {
          filter_expression: payload.filter_expression,
          truncated: false,
        },
      };
    }
    const truncated = keys.length === FT_SEARCH_LIMIT;
    let deleted: number;
    try {
      deleted = await client.del(...keys);
    } catch (err) {
      throw new ApplyFailedError(proposalId, `DEL failed during invalidate`, {
        reason: 'valkey_command_failed',
        cacheName: cache.name,
        underlying: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      actualAffected: deleted,
      details: {
        filter_expression: payload.filter_expression,
        truncated,
      },
    };
  }

  private async applyAgentInvalidate(
    client: Valkey,
    cache: ResolvedCache,
    payload: AgentInvalidatePayload,
    proposalId: string,
  ): Promise<Omit<ApplyOutcome, 'durationMs'>> {
    if (payload.filter_kind === 'tool') {
      const pattern = `${escapeGlob(cache.prefix)}:tool:${escapeGlob(payload.filter_value)}:*`;
      const deleted = await scanAndDelete(client, pattern);
      return {
        actualAffected: deleted,
        details: { filter_kind: 'tool', tool_name: payload.filter_value },
      };
    }
    if (payload.filter_kind === 'key_prefix') {
      const pattern = `${escapeGlob(cache.prefix)}:${escapeGlob(payload.filter_value)}*`;
      const deleted = await scanAndDelete(client, pattern);
      return {
        actualAffected: deleted,
        details: { filter_kind: 'key_prefix', prefix: payload.filter_value },
      };
    }
    if (payload.filter_kind === 'session') {
      const pattern = `${escapeGlob(cache.prefix)}:session:${escapeGlob(payload.filter_value)}*`;
      const deleted = await scanAndDelete(client, pattern);
      return {
        actualAffected: deleted,
        details: { filter_kind: 'session', session_id: payload.filter_value },
      };
    }
    throw new ApplyFailedError(
      proposalId,
      `Unknown agent_cache invalidate filter_kind: ${(payload as { filter_kind: string }).filter_kind}`,
    );
  }
}

function parseFtSearchKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const keys: string[] = [];
  for (let i = 1; i < raw.length; i += 1) {
    const key = raw[i];
    if (typeof key === 'string') {
      keys.push(key);
    }
  }
  return keys;
}

function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

async function scanAndDelete(client: Valkey, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = (await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500)) as [
      string,
      string[],
    ];
    cursor = next;
    if (keys.length > 0) {
      const removed = await client.del(...keys);
      deleted += removed;
    }
  } while (cursor !== '0');
  return deleted;
}
