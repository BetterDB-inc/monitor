import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  MEMORY_PROPOSAL_DEFAULT_EXPIRY_MS,
  type StoredMemoryProposal,
  type MemoryForgetPayload,
  type CreateMemoryProposalInput,
  type ActorSource,
  type ProposalAuditEvent,
} from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { SlidingWindowRateLimiter } from '../cache-proposals/rate-limiter';
import { MemoryApplyService, type MemoryApplyResult } from './memory-apply.service';
import {
  MemoryProposalValidationError,
  DuplicatePendingMemoryProposalError,
  MemoryProposalNotFoundError,
  MemoryProposalNotPendingError,
  MemoryProposalExpiredError,
  MemoryProposalRateLimitedError,
} from './errors';

const REASONING_MIN_LENGTH = 20;
const PROPOSAL_RATE_LIMIT = 30;
const PROPOSAL_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface ProposeForgetInput {
  storeName: string;
  reasoning: string;
  memoryId?: string;
  scope?: { threadId?: string; agentId?: string; namespace?: string };
  tags?: string[];
  proposedBy?: string;
}

export interface ProposeForgetResult {
  proposal: StoredMemoryProposal;
  warnings: string[];
}

@Injectable()
export class MemoryProposalService {
  private readonly logger = new Logger(MemoryProposalService.name);
  private readonly rateLimiter = new SlidingWindowRateLimiter(
    PROPOSAL_RATE_LIMIT,
    PROPOSAL_RATE_WINDOW_MS,
  );

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    @Optional() private readonly applyService?: MemoryApplyService,
  ) {}

  async proposeForget(
    connectionId: string,
    input: ProposeForgetInput,
  ): Promise<ProposeForgetResult> {
    requireReasoning(input.reasoning);
    const payload = buildForgetPayload(input);
    await this.rejectIfDuplicatePending(connectionId, input.storeName, payload);

    const reservation = this.rateLimiter.reserve(connectionId);
    if (!reservation.allowed) {
      throw new MemoryProposalRateLimitedError(
        reservation.retryAfterMs,
        PROPOSAL_RATE_LIMIT,
        PROPOSAL_RATE_WINDOW_MS,
      );
    }

    const proposedAt = Date.now();
    const createInput: CreateMemoryProposalInput = {
      id: randomUUID(),
      connection_id: connectionId,
      store_name: input.storeName,
      proposal_type: 'forget',
      proposal_payload: payload,
      reasoning: input.reasoning,
      proposed_by: input.proposedBy ?? null,
      proposed_at: proposedAt,
      expires_at: proposedAt + MEMORY_PROPOSAL_DEFAULT_EXPIRY_MS,
    };

    let proposal: StoredMemoryProposal;
    try {
      proposal = await this.storage.createMemoryProposal(createInput);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicatePendingMemoryProposalError({ store_name: input.storeName });
      }
      if (reservation.releaseToken !== undefined) {
        this.rateLimiter.release(connectionId, reservation.releaseToken);
      }
      throw err;
    }

    await this.appendAudit(proposal.id, 'proposed', null, input.proposedBy ?? null, 'mcp');
    return { proposal, warnings: [] };
  }

  async listPending(
    connectionId: string,
    options: { storeName?: string; limit?: number } = {},
  ): Promise<StoredMemoryProposal[]> {
    return this.storage.listMemoryProposals({
      connection_id: connectionId,
      status: 'pending',
      store_name: options.storeName,
      limit: options.limit ?? 50,
    });
  }

  async get(proposalId: string): Promise<StoredMemoryProposal | null> {
    return this.storage.getMemoryProposal(proposalId);
  }

  async expireProposals(now: number, actorSource: ActorSource = 'system'): Promise<number> {
    const expired = await this.storage.expireMemoryProposalsBefore(now);
    for (const proposal of expired) {
      try {
        await this.appendAudit(
          proposal.id,
          'expired',
          { expires_at: proposal.expires_at },
          'system',
          actorSource,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to write expired audit for ${proposal.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return expired.length;
  }

  async approve(input: {
    proposalId: string;
    actor: string | null;
    actorSource: ActorSource;
  }): Promise<MemoryApplyResult> {
    const approved = await this.transitionToApproved(input);
    if (this.applyService === undefined) {
      return {
        proposal: approved,
        appliedResult: approved.applied_result ?? { success: false, error: 'apply unavailable' },
      };
    }
    return this.applyService.apply(approved, { actor: input.actor, actorSource: input.actorSource });
  }

  async reject(input: {
    proposalId: string;
    reason?: string | null;
    actor: string | null;
    actorSource: ActorSource;
  }): Promise<StoredMemoryProposal> {
    await this.requireFreshPending(input.proposalId);
    const updated = await this.storage.updateMemoryProposalStatus({
      id: input.proposalId,
      expected_status: ['pending'],
      status: 'rejected',
      reviewed_by: input.actor,
      reviewed_at: Date.now(),
    });
    if (updated === null) {
      throw new MemoryProposalNotPendingError(input.proposalId);
    }
    await this.appendAudit(
      input.proposalId,
      'rejected',
      input.reason ? { reason: input.reason } : null,
      input.actor,
      input.actorSource,
    );
    return updated;
  }

  private async transitionToApproved(input: {
    proposalId: string;
    actor: string | null;
    actorSource: ActorSource;
  }): Promise<StoredMemoryProposal> {
    const existing = await this.storage.getMemoryProposal(input.proposalId);
    if (existing === null) {
      throw new MemoryProposalNotFoundError(input.proposalId);
    }
    if (
      existing.status === 'approved' ||
      existing.status === 'applied' ||
      existing.status === 'failed'
    ) {
      return existing;
    }
    if (existing.status !== 'pending') {
      throw new MemoryProposalNotPendingError(input.proposalId);
    }
    if (existing.expires_at <= Date.now()) {
      throw new MemoryProposalExpiredError(input.proposalId);
    }
    const updated = await this.storage.updateMemoryProposalStatus({
      id: input.proposalId,
      expected_status: ['pending'],
      status: 'approved',
      reviewed_by: input.actor,
      reviewed_at: Date.now(),
    });
    if (updated === null) {
      throw new MemoryProposalNotPendingError(input.proposalId);
    }
    await this.appendAudit(input.proposalId, 'approved', null, input.actor, input.actorSource);
    return updated;
  }

  private async requireFreshPending(proposalId: string): Promise<StoredMemoryProposal> {
    const existing = await this.storage.getMemoryProposal(proposalId);
    if (existing === null) {
      throw new MemoryProposalNotFoundError(proposalId);
    }
    if (existing.status !== 'pending') {
      throw new MemoryProposalNotPendingError(proposalId);
    }
    if (existing.expires_at <= Date.now()) {
      throw new MemoryProposalExpiredError(proposalId);
    }
    return existing;
  }

  private async rejectIfDuplicatePending(
    connectionId: string,
    storeName: string,
    payload: MemoryForgetPayload,
  ): Promise<void> {
    const pending = await this.storage.listMemoryProposals({
      connection_id: connectionId,
      status: 'pending',
      store_name: storeName,
      limit: 1000,
    });
    const target = targetDiscriminator(payload);
    const clash = pending.some((p) => targetDiscriminator(p.proposal_payload) === target);
    if (clash) {
      throw new DuplicatePendingMemoryProposalError({ store_name: storeName });
    }
  }

  private async appendAudit(
    proposalId: string,
    eventType: ProposalAuditEvent,
    eventPayload: Record<string, unknown> | null,
    actor: string | null,
    actorSource: ActorSource,
  ): Promise<void> {
    await this.storage.appendMemoryProposalAudit({
      id: randomUUID(),
      proposal_id: proposalId,
      event_type: eventType,
      event_payload: eventPayload,
      event_at: Date.now(),
      actor,
      actor_source: actorSource,
    });
  }
}

function requireReasoning(reasoning: string): void {
  if (typeof reasoning !== 'string' || reasoning.trim().length < REASONING_MIN_LENGTH) {
    throw new MemoryProposalValidationError(
      `reasoning must be at least ${REASONING_MIN_LENGTH} characters`,
    );
  }
}

function buildForgetPayload(input: ProposeForgetInput): MemoryForgetPayload {
  if (input.memoryId !== undefined && input.memoryId.length > 0) {
    return { target_kind: 'id', memory_id: input.memoryId };
  }
  const scope = input.scope ?? {};
  const hasScope =
    scope.threadId !== undefined || scope.agentId !== undefined || scope.namespace !== undefined;
  const hasTags = Array.isArray(input.tags) && input.tags.length > 0;
  if (!hasScope && !hasTags) {
    throw new MemoryProposalValidationError(
      'forget requires a memory id, or at least one scope field or tag',
    );
  }
  return { target_kind: 'scope', scope: hasScope ? scope : undefined, tags: input.tags };
}

function targetDiscriminator(payload: MemoryForgetPayload): string {
  if (payload.target_kind === 'id') {
    return `id:${payload.memory_id}`;
  }
  const scope = payload.scope ?? {};
  const tags = Array.isArray(payload.tags) ? [...payload.tags].sort() : [];
  return `scope:${JSON.stringify(scope)}|tags:${tags.join(',')}`;
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique/i.test(message);
}
