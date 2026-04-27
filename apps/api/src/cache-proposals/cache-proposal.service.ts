import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AgentInvalidatePayloadSchema,
  AgentToolTtlAdjustPayloadSchema,
  PROPOSAL_DEFAULT_EXPIRY_MS,
  SemanticInvalidatePayloadSchema,
  SemanticThresholdAdjustPayloadSchema,
  type CreateCacheProposalInput,
  type StoredCacheProposal,
} from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import {
  CacheNotFoundError,
  CacheProposalValidationError,
  DuplicatePendingProposalError,
  InvalidCacheTypeError,
  RateLimitedError,
} from './errors';
import { CacheResolverService, type ResolvedCache } from './cache-resolver.service';
import { SlidingWindowRateLimiter } from './rate-limiter';

const REASONING_MIN_LENGTH = 20;
const PROPOSAL_RATE_LIMIT = 30;
const PROPOSAL_RATE_WINDOW_MS = 60 * 60 * 1000;
const ESTIMATED_AFFECTED_WARN_THRESHOLD = 10_000;

export interface ProposeThresholdAdjustInput {
  cacheName: string;
  category?: string | null;
  newThreshold: number;
  reasoning: string;
  proposedBy?: string;
}

export interface ProposeToolTtlAdjustInput {
  cacheName: string;
  toolName: string;
  newTtlSeconds: number;
  reasoning: string;
  proposedBy?: string;
}

export type ProposeInvalidateInput =
  | {
      cacheName: string;
      filterKind: 'valkey_search';
      filterExpression: string;
      estimatedAffected: number;
      reasoning: string;
      proposedBy?: string;
    }
  | {
      cacheName: string;
      filterKind: 'tool' | 'key_prefix' | 'session';
      filterValue: string;
      estimatedAffected: number;
      reasoning: string;
      proposedBy?: string;
    };

export interface ProposeResult {
  proposal: StoredCacheProposal;
  warnings: string[];
}

@Injectable()
export class CacheProposalService {
  private readonly logger = new Logger(CacheProposalService.name);
  private readonly rateLimiter: SlidingWindowRateLimiter;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly resolver: CacheResolverService,
  ) {
    this.rateLimiter = new SlidingWindowRateLimiter(
      PROPOSAL_RATE_LIMIT,
      PROPOSAL_RATE_WINDOW_MS,
    );
  }

  async proposeThresholdAdjust(
    connectionId: string,
    input: ProposeThresholdAdjustInput,
  ): Promise<ProposeResult> {
    this.requireReasoning(input.reasoning);
    const cache = await this.requireCache(connectionId, input.cacheName, 'semantic_cache');

    const category = input.category ?? null;
    const currentThreshold = await this.readCurrentThreshold(cache, category);
    const payload = SemanticThresholdAdjustPayloadSchema.parse({
      category,
      current_threshold: currentThreshold,
      new_threshold: input.newThreshold,
    });

    await this.rejectIfDuplicatePending(connectionId, input.cacheName, 'threshold_adjust', (p) => {
      if (p.cache_type !== 'semantic_cache' || p.proposal_type !== 'threshold_adjust') {
        return false;
      }
      return p.proposal_payload.category === category;
    });

    return this.persist(connectionId, {
      cache_type: 'semantic_cache',
      proposal_type: 'threshold_adjust',
      proposal_payload: payload,
      cacheName: input.cacheName,
      reasoning: input.reasoning,
      proposedBy: input.proposedBy,
      warnings: [],
    });
  }

  async proposeToolTtlAdjust(
    connectionId: string,
    input: ProposeToolTtlAdjustInput,
  ): Promise<ProposeResult> {
    this.requireReasoning(input.reasoning);
    const cache = await this.requireCache(connectionId, input.cacheName, 'agent_cache');

    const currentTtlSeconds = await this.readCurrentToolTtl(cache, input.toolName);
    const payload = AgentToolTtlAdjustPayloadSchema.parse({
      tool_name: input.toolName,
      current_ttl_seconds: currentTtlSeconds,
      new_ttl_seconds: input.newTtlSeconds,
    });

    await this.rejectIfDuplicatePending(connectionId, input.cacheName, 'tool_ttl_adjust', (p) => {
      if (p.cache_type !== 'agent_cache' || p.proposal_type !== 'tool_ttl_adjust') {
        return false;
      }
      return p.proposal_payload.tool_name === input.toolName;
    });

    return this.persist(connectionId, {
      cache_type: 'agent_cache',
      proposal_type: 'tool_ttl_adjust',
      proposal_payload: payload,
      cacheName: input.cacheName,
      reasoning: input.reasoning,
      proposedBy: input.proposedBy,
      warnings: [],
    });
  }

  async proposeInvalidate(
    connectionId: string,
    input: ProposeInvalidateInput,
  ): Promise<ProposeResult> {
    this.requireReasoning(input.reasoning);
    const cache = await this.requireCacheAny(connectionId, input.cacheName);

    const warnings: string[] = [];
    if (input.estimatedAffected > ESTIMATED_AFFECTED_WARN_THRESHOLD) {
      warnings.push(
        `estimated_affected=${input.estimatedAffected} exceeds advisory threshold ${ESTIMATED_AFFECTED_WARN_THRESHOLD}`,
      );
    }

    if (cache.type === 'semantic_cache') {
      if (input.filterKind !== 'valkey_search') {
        throw new CacheProposalValidationError(
          `Semantic cache invalidate requires filter_kind='valkey_search', got '${input.filterKind}'`,
          { cacheType: cache.type, filterKind: input.filterKind },
        );
      }
      const expression = 'filterExpression' in input ? input.filterExpression : '';
      const payload = SemanticInvalidatePayloadSchema.parse({
        filter_kind: 'valkey_search',
        filter_expression: expression,
        estimated_affected: input.estimatedAffected,
      });
      return this.persist(connectionId, {
        cache_type: 'semantic_cache',
        proposal_type: 'invalidate',
        proposal_payload: payload,
        cacheName: input.cacheName,
        reasoning: input.reasoning,
        proposedBy: input.proposedBy,
        warnings,
      });
    }

    if (input.filterKind === 'valkey_search') {
      throw new CacheProposalValidationError(
        `Agent cache invalidate requires filter_kind in ('tool','key_prefix','session'), got 'valkey_search'`,
        { cacheType: cache.type, filterKind: input.filterKind },
      );
    }
    const value = 'filterValue' in input ? input.filterValue : '';
    const payload = AgentInvalidatePayloadSchema.parse({
      filter_kind: input.filterKind,
      filter_value: value,
      estimated_affected: input.estimatedAffected,
    });
    return this.persist(connectionId, {
      cache_type: 'agent_cache',
      proposal_type: 'invalidate',
      proposal_payload: payload,
      cacheName: input.cacheName,
      reasoning: input.reasoning,
      proposedBy: input.proposedBy,
      warnings,
    });
  }

  private requireReasoning(reasoning: string): void {
    if (typeof reasoning !== 'string' || reasoning.trim().length < REASONING_MIN_LENGTH) {
      throw new CacheProposalValidationError(
        `reasoning must be at least ${REASONING_MIN_LENGTH} characters`,
        { minLength: REASONING_MIN_LENGTH },
      );
    }
  }

  private async requireCache(
    connectionId: string,
    cacheName: string,
    expected: 'agent_cache' | 'semantic_cache',
  ): Promise<ResolvedCache> {
    const cache = await this.requireCacheAny(connectionId, cacheName);
    if (cache.type !== expected) {
      throw new InvalidCacheTypeError(expected, cache.type, cacheName);
    }
    return cache;
  }

  private async requireCacheAny(connectionId: string, cacheName: string): Promise<ResolvedCache> {
    const cache = await this.resolver.resolveCacheByName(connectionId, cacheName);
    if (cache === null) {
      throw new CacheNotFoundError(cacheName);
    }
    return cache;
  }

  private async rejectIfDuplicatePending(
    connectionId: string,
    cacheName: string,
    proposalType: 'threshold_adjust' | 'tool_ttl_adjust',
    matches: (proposal: StoredCacheProposal) => boolean,
  ): Promise<void> {
    const pending = await this.storage.listCacheProposals({
      connection_id: connectionId,
      status: 'pending',
      cache_name: cacheName,
      proposal_type: proposalType,
    });
    const conflict = pending.find(matches);
    if (conflict) {
      throw new DuplicatePendingProposalError(cacheName, proposalType, {
        existing_proposal_id: conflict.id,
      });
    }
  }

  private async persist(
    connectionId: string,
    args: {
      cache_type: 'agent_cache' | 'semantic_cache';
      proposal_type: 'threshold_adjust' | 'tool_ttl_adjust' | 'invalidate';
      proposal_payload: CreateCacheProposalInput['proposal_payload'];
      cacheName: string;
      reasoning: string;
      proposedBy?: string;
      warnings: string[];
    },
  ): Promise<ProposeResult> {
    const reservation = this.rateLimiter.reserve(connectionId);
    if (!reservation.allowed) {
      throw new RateLimitedError(
        reservation.retryAfterMs,
        PROPOSAL_RATE_LIMIT,
        PROPOSAL_RATE_WINDOW_MS,
      );
    }

    const proposedAt = Date.now();
    const expiresAt = proposedAt + PROPOSAL_DEFAULT_EXPIRY_MS;
    const input = {
      id: randomUUID(),
      connection_id: connectionId,
      cache_name: args.cacheName,
      cache_type: args.cache_type,
      proposal_type: args.proposal_type,
      proposal_payload: args.proposal_payload,
      reasoning: args.reasoning,
      proposed_by: args.proposedBy ?? null,
      proposed_at: proposedAt,
      expires_at: expiresAt,
    } as CreateCacheProposalInput;

    let proposal: StoredCacheProposal;
    try {
      proposal = await this.storage.createCacheProposal(input);
    } catch (err) {
      this.rateLimiter.release(connectionId);
      throw err;
    }
    this.logger.log(
      `Created ${args.cache_type}/${args.proposal_type} proposal ${proposal.id} for ${args.cacheName} on ${connectionId}`,
    );
    return { proposal, warnings: args.warnings };
  }

  private async readCurrentThreshold(
    _cache: ResolvedCache,
    _category: string | null,
  ): Promise<number> {
    return 0;
  }

  private async readCurrentToolTtl(_cache: ResolvedCache, _toolName: string): Promise<number> {
    return 0;
  }
}
