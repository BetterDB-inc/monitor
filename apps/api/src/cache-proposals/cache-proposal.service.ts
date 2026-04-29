import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AGENT_CACHE,
  AgentInvalidatePayloadSchema,
  AgentToolTtlAdjustPayloadSchema,
  PROPOSAL_DEFAULT_EXPIRY_MS,
  SEMANTIC_CACHE,
  SemanticInvalidatePayloadSchema,
  SemanticThresholdAdjustPayloadSchema,
  type ActorSource,
  type AppliedResult,
  type CacheType,
  type CreateCacheProposalInput,
  type ListCacheProposalsOptions,
  type ProposalStatus,
  type StoredCacheProposal,
  type StoredCacheProposalAudit,
  type UpdateProposalStatusInput,
} from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import {
  ApplyFailedError,
  CacheNotFoundError,
  CacheProposalValidationError,
  DuplicatePendingProposalError,
  InvalidCacheTypeError,
  ProposalEditNotAllowedError,
  ProposalExpiredError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  RateLimitedError,
} from './errors';
import { CacheResolverService, type ResolvedCache } from './cache-resolver.service';
import { SlidingWindowRateLimiter } from './rate-limiter';
import { CacheApplyService, type ApplyContext } from './cache-apply.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';

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
    @Optional() private readonly applyService?: CacheApplyService,
    @Optional() private readonly registry?: ConnectionRegistry,
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
    const currentThreshold = await this.readCurrentThreshold(connectionId, cache, category);
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

    const currentTtlSeconds = await this.readCurrentToolTtl(connectionId, cache, input.toolName);
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
      // Duplicate-pending is a client error — keep the rate-limit slot consumed
      // so callers cannot spam the endpoint without budget cost.
      if (isUniqueConstraintViolation(err)) {
        throw new DuplicatePendingProposalError(args.cacheName, args.proposal_type, {
          reason: 'concurrent insert lost the race against an existing pending proposal',
        });
      }
      // Genuine storage failure — refund the slot so the caller can retry.
      if (releaseToken !== undefined) {
        this.rateLimiter.release(connectionId, releaseToken);
      }
      throw err;
    }
    this.logger.log(
      `Created ${args.cache_type}/${args.proposal_type} proposal ${proposal.id} for ${args.cacheName} on ${connectionId}`,
    );
    return { proposal, warnings: args.warnings };
  }

  private async readCurrentThreshold(
    connectionId: string,
    cache: ResolvedCache,
    category: string | null,
  ): Promise<number> {
    if (this.registry === undefined) {
      return 0;
    }
    try {
      const client = this.registry.get(connectionId).getClient();
      const raw = (await client.hgetall(`${cache.prefix}:__config`)) ?? {};
      // Prefer dispatcher-written override fields (threshold / threshold:<category>),
      // which reflect the actually effective value after a prior apply. Fall back
      // to the SDK-published baseline (default_threshold / category_thresholds JSON).
      const overrideField = category === null ? 'threshold' : `threshold:${category}`;
      const overrideRaw = raw[overrideField];
      if (typeof overrideRaw === 'string' && overrideRaw.length > 0) {
        const overrideValue = Number(overrideRaw);
        if (Number.isFinite(overrideValue)) {
          return overrideValue;
        }
      }
      if (category !== null) {
        const categoryRaw = raw.category_thresholds;
        if (typeof categoryRaw === 'string' && categoryRaw.length > 0) {
          try {
            const parsed = JSON.parse(categoryRaw) as Record<string, unknown>;
            const value = parsed[category];
            if (typeof value === 'number' && Number.isFinite(value)) {
              return value;
            }
          } catch {
            // fall through
          }
        }
      } else {
        const value = Number(raw.default_threshold);
        if (Number.isFinite(value)) {
          return value;
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to read current threshold for ${cache.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 0;
  }

  private async readCurrentToolTtl(
    connectionId: string,
    cache: ResolvedCache,
    toolName: string,
  ): Promise<number> {
    if (this.registry === undefined) {
      return 0;
    }
    try {
      const client = this.registry.get(connectionId).getClient();
      const raw = await client.hget(`${cache.prefix}:__tool_policies`, toolName);
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as { ttl?: unknown };
          if (typeof parsed.ttl === 'number' && Number.isFinite(parsed.ttl)) {
            return parsed.ttl;
          }
        } catch {
          // fall through
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to read current TTL for ${cache.name}/${toolName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 0;
  }

  async getProposal(proposalId: string): Promise<StoredCacheProposal> {
    const proposal = await this.storage.getCacheProposal(proposalId);
    if (proposal === null) {
      throw new ProposalNotFoundError(proposalId);
    }
    return proposal;
  }

  async getProposalWithAudit(
    proposalId: string,
  ): Promise<{ proposal: StoredCacheProposal; audit: StoredCacheProposalAudit[] }> {
    const proposal = await this.getProposal(proposalId);
    const audit = await this.storage.getCacheProposalAudit(proposalId);
    return { proposal, audit };
  }

  listProposals(options: ListCacheProposalsOptions): Promise<StoredCacheProposal[]> {
    return this.storage.listCacheProposals(options);
  }

  async approve(input: {
    proposalId: string;
    actor: string | null;
    actorSource: ActorSource;
  }): Promise<{ proposal: StoredCacheProposal; appliedResult: AppliedResult | null }> {
    const proposal = await this.transitionToApproved(input);
    return this.runApply(proposal, { actor: input.actor, actorSource: input.actorSource });
  }

  async reject(input: {
    proposalId: string;
    reason?: string | null;
    actor: string | null;
    actorSource: ActorSource;
  }): Promise<StoredCacheProposal> {
    const existing = await this.requireFreshPending(input.proposalId);
    const reviewedAt = Date.now();
    const updated = await this.storage.updateCacheProposalStatus({
      id: existing.id,
      expected_status: ['pending'],
      status: 'rejected',
      reviewed_by: input.actor,
      reviewed_at: reviewedAt,
    });
    if (updated === null) {
      const reread = await this.storage.getCacheProposal(input.proposalId);
      throw new ProposalNotPendingError(input.proposalId, reread?.status ?? 'unknown');
    }
    await this.appendAudit({
      proposalId: updated.id,
      eventType: 'rejected',
      eventPayload: input.reason ? { reason: input.reason } : null,
      actor: input.actor,
      actorSource: input.actorSource,
      eventAt: reviewedAt,
    });
    return updated;
  }

  async editAndApprove(input: {
    proposalId: string;
    edits: { newThreshold?: number; newTtlSeconds?: number };
    actor: string | null;
    actorSource: ActorSource;
  }): Promise<{ proposal: StoredCacheProposal; appliedResult: AppliedResult | null }> {
    const existing = await this.requireFreshPending(input.proposalId);

    if (existing.proposal_type === 'invalidate') {
      throw new ProposalEditNotAllowedError(
        input.proposalId,
        'Invalidate proposals cannot be edited in v1 — reject and re-propose',
      );
    }

    let newPayload: UpdateProposalStatusInput['proposal_payload'];
    if (existing.proposal_type === 'threshold_adjust') {
      if (typeof input.edits.newThreshold !== 'number') {
        throw new CacheProposalValidationError(
          'new_threshold is required for editing a threshold_adjust proposal',
          { proposalType: existing.proposal_type },
        );
      }
      if (input.edits.newTtlSeconds !== undefined) {
        throw new CacheProposalValidationError(
          'new_ttl_seconds is not valid for a threshold_adjust proposal',
          { proposalType: existing.proposal_type },
        );
      }
      newPayload = SemanticThresholdAdjustPayloadSchema.parse({
        ...existing.proposal_payload,
        new_threshold: input.edits.newThreshold,
      });
    } else if (existing.proposal_type === 'tool_ttl_adjust') {
      if (typeof input.edits.newTtlSeconds !== 'number') {
        throw new CacheProposalValidationError(
          'new_ttl_seconds is required for editing a tool_ttl_adjust proposal',
          { proposalType: existing.proposal_type },
        );
      }
      if (input.edits.newThreshold !== undefined) {
        throw new CacheProposalValidationError(
          'new_threshold is not valid for a tool_ttl_adjust proposal',
          { proposalType: existing.proposal_type },
        );
      }
      newPayload = AgentToolTtlAdjustPayloadSchema.parse({
        ...existing.proposal_payload,
        new_ttl_seconds: input.edits.newTtlSeconds,
      });
    } else {
      const exhaustive = existing as { proposal_type: string };
      throw new ProposalEditNotAllowedError(
        input.proposalId,
        `Editing is not supported for proposal_type='${exhaustive.proposal_type}'`,
      );
    }

    const reviewedAt = Date.now();
    const approved = await this.storage.updateCacheProposalStatus({
      id: existing.id,
      expected_status: ['pending'],
      status: 'approved',
      reviewed_by: input.actor,
      reviewed_at: reviewedAt,
      proposal_payload: newPayload,
    });
    if (approved === null) {
      const reread = await this.storage.getCacheProposal(input.proposalId);
      throw new ProposalNotPendingError(input.proposalId, reread?.status ?? 'unknown');
    }
    await this.appendAudit({
      proposalId: approved.id,
      eventType: 'edited_and_approved',
      eventPayload: { edits: input.edits },
      actor: input.actor,
      actorSource: input.actorSource,
      eventAt: reviewedAt,
    });
    return this.runApply(approved, { actor: input.actor, actorSource: input.actorSource });
  }

  async expireProposals(now: number, actorSource: ActorSource = 'system'): Promise<number> {
    const expired = await this.storage.expireCacheProposalsBefore(now);
    for (const proposal of expired) {
      try {
        await this.appendAudit({
          proposalId: proposal.id,
          eventType: 'expired',
          eventPayload: { expires_at: proposal.expires_at },
          actor: 'system',
          actorSource,
          eventAt: now,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to write expired audit for ${proposal.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return expired.length;
  }

  private async transitionToApproved(input: {
    proposalId: string;
    actor: string | null;
    actorSource: ActorSource;
  }): Promise<StoredCacheProposal> {
    const existing = await this.storage.getCacheProposal(input.proposalId);
    if (existing === null) {
      throw new ProposalNotFoundError(input.proposalId);
    }
    if (existing.status === 'approved' || existing.status === 'applied' || existing.status === 'failed') {
      return existing;
    }
    if (existing.status !== 'pending') {
      throw new ProposalNotPendingError(input.proposalId, existing.status);
    }
    if (existing.expires_at <= Date.now()) {
      throw new ProposalExpiredError(input.proposalId, existing.expires_at);
    }

    const reviewedAt = Date.now();
    const approved = await this.storage.updateCacheProposalStatus({
      id: existing.id,
      expected_status: ['pending'],
      status: 'approved',
      reviewed_by: input.actor,
      reviewed_at: reviewedAt,
    });
    if (approved === null) {
      const reread = await this.storage.getCacheProposal(input.proposalId);
      if (
        reread !== null &&
        (reread.status === 'approved' || reread.status === 'applied' || reread.status === 'failed')
      ) {
        return reread;
      }
      throw new ProposalNotPendingError(input.proposalId, reread?.status ?? 'unknown');
    }
    await this.appendAudit({
      proposalId: approved.id,
      eventType: 'approved',
      eventPayload: null,
      actor: input.actor,
      actorSource: input.actorSource,
      eventAt: reviewedAt,
    });
    return approved;
  }

  private async runApply(
    proposal: StoredCacheProposal,
    context: ApplyContext,
  ): Promise<{ proposal: StoredCacheProposal; appliedResult: AppliedResult | null }> {
    if (this.applyService === undefined) {
      this.logger.warn(
        `CacheApplyService not wired — proposal ${proposal.id} stays in 'approved' without dispatch`,
      );
      return { proposal, appliedResult: null };
    }
    const wasAlreadyTerminal = proposal.status === 'applied' || proposal.status === 'failed';
    const result = await this.applyService.apply(proposal, context);
    if (!result.appliedResult.success && !wasAlreadyTerminal) {
      throw new ApplyFailedError(
        proposal.id,
        result.appliedResult.error ?? 'apply failed',
        result.appliedResult.details,
      );
    }
    return { proposal: result.proposal, appliedResult: result.appliedResult };
  }

  private async requireFreshPending(proposalId: string): Promise<StoredCacheProposal> {
    const existing = await this.storage.getCacheProposal(proposalId);
    if (existing === null) {
      throw new ProposalNotFoundError(proposalId);
    }
    if (existing.status !== 'pending') {
      throw new ProposalNotPendingError(proposalId, existing.status);
    }
    if (existing.expires_at < Date.now()) {
      throw new ProposalExpiredError(proposalId, existing.expires_at);
    }
    return existing;
  }

  private async appendAudit(args: {
    proposalId: string;
    eventType: 'approved' | 'rejected' | 'edited_and_approved' | 'expired' | 'applied' | 'failed';
    eventPayload: Record<string, unknown> | null;
    actor: string | null;
    actorSource: ActorSource;
    eventAt: number;
  }): Promise<void> {
    await this.storage.appendCacheProposalAudit({
      id: randomUUID(),
      proposal_id: args.proposalId,
      event_type: args.eventType,
      event_payload: args.eventPayload,
      event_at: args.eventAt,
      actor: args.actor,
      actor_source: args.actorSource,
    });
  }
}

export type { ProposalStatus };
