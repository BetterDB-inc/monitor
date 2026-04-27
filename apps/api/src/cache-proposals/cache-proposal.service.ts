import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AGENT_CACHE,
  AgentInvalidatePayloadSchema,
  AgentToolTtlAdjustPayloadSchema,
  PROPOSAL_DEFAULT_EXPIRY_MS,
  SEMANTIC_CACHE,
  SemanticInvalidatePayloadSchema,
  SemanticThresholdAdjustPayloadSchema,
  type CacheType,
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

const SQLITE_UNIQUE_VIOLATION_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
]);

function isUniqueConstraintViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string' && e.code === '23505') {
    return true;
  }
  if (typeof e.code === 'string' && SQLITE_UNIQUE_VIOLATION_CODES.has(e.code)) {
    return true;
  }
  if (typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message)) {
    return true;
  }
  return false;
}

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
    const cache = await this.requireCache(connectionId, input.cacheName, SEMANTIC_CACHE);

    const category = input.category ?? null;
    const currentThreshold = await this.readCurrentThreshold(cache, category);
    const payload = SemanticThresholdAdjustPayloadSchema.parse({
      category,
      current_threshold: currentThreshold,
      new_threshold: input.newThreshold,
    });

    await this.rejectIfDuplicatePending(connectionId, input.cacheName, 'threshold_adjust', (p) => {
      if (p.cache_type !== SEMANTIC_CACHE || p.proposal_type !== 'threshold_adjust') {
        return false;
      }
      return p.proposal_payload.category === category;
    });

    return this.persist(connectionId, {
      cache_type: SEMANTIC_CACHE,
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
    const cache = await this.requireCache(connectionId, input.cacheName, AGENT_CACHE);

    const currentTtlSeconds = await this.readCurrentToolTtl(cache, input.toolName);
    const payload = AgentToolTtlAdjustPayloadSchema.parse({
      tool_name: input.toolName,
      current_ttl_seconds: currentTtlSeconds,
      new_ttl_seconds: input.newTtlSeconds,
    });

    await this.rejectIfDuplicatePending(connectionId, input.cacheName, 'tool_ttl_adjust', (p) => {
      if (p.cache_type !== AGENT_CACHE || p.proposal_type !== 'tool_ttl_adjust') {
        return false;
      }
      return p.proposal_payload.tool_name === input.toolName;
    });

    return this.persist(connectionId, {
      cache_type: AGENT_CACHE,
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

    if (cache.type === SEMANTIC_CACHE) {
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
        cache_type: SEMANTIC_CACHE,
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
      cache_type: AGENT_CACHE,
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
    expected: CacheType,
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
    const conflict = await this.findFirstPendingMatch(
      connectionId,
      cacheName,
      proposalType,
      matches,
    );
    if (conflict) {
      throw new DuplicatePendingProposalError(cacheName, proposalType, {
        existing_proposal_id: conflict.id,
      });
    }
  }

  private async findFirstPendingMatch(
    connectionId: string,
    cacheName: string,
    proposalType: 'threshold_adjust' | 'tool_ttl_adjust',
    matches: (proposal: StoredCacheProposal) => boolean,
  ): Promise<StoredCacheProposal | null> {
    const pageSize = 200;
    const maxPages = 10;
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await this.storage.listCacheProposals({
        connection_id: connectionId,
        status: 'pending',
        cache_name: cacheName,
        proposal_type: proposalType,
        limit: pageSize,
        offset: page * pageSize,
      });
      const found = batch.find(matches);
      if (found) {
        return found;
      }
      if (batch.length < pageSize) {
        return null;
      }
    }
    return null;
  }

  private async persist(
    connectionId: string,
    args: {
      cache_type: CacheType;
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

    const releaseToken = reservation.releaseToken;
    let proposal: StoredCacheProposal;
    try {
      proposal = await this.storage.createCacheProposal(input);
    } catch (err) {
      if (releaseToken !== undefined) {
        this.rateLimiter.release(connectionId, releaseToken);
      }
      if (isUniqueConstraintViolation(err)) {
        throw new DuplicatePendingProposalError(args.cacheName, args.proposal_type, {
          reason: 'concurrent insert lost the race against an existing pending proposal',
        });
      }
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
