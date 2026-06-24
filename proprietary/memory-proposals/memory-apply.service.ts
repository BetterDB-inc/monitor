import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { StoredMemoryProposal, AppliedResult, ActorSource } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { MemoryApplyDispatcher, type ApplyOutcome } from './memory-apply.dispatcher';

export interface MemoryApplyContext {
  actor: string | null;
  actorSource: ActorSource;
}

export interface MemoryApplyResult {
  proposal: StoredMemoryProposal;
  appliedResult: AppliedResult;
}

@Injectable()
export class MemoryApplyService {
  private readonly logger = new Logger(MemoryApplyService.name);

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly dispatcher: MemoryApplyDispatcher,
  ) {}

  async apply(
    approved: StoredMemoryProposal,
    context: MemoryApplyContext,
  ): Promise<MemoryApplyResult> {
    if (approved.status === 'applied' || approved.status === 'failed') {
      const cached = approved.applied_result ?? { success: approved.status === 'applied' };
      return { proposal: approved, appliedResult: cached };
    }

    // Atomically claim the proposal before dispatching so two concurrent
    // approvals cannot run the forget twice: only the first `approved -> applying`
    // transition wins. Status stays `applying` (not `applied`) until the forget
    // actually completes, so a crash mid-apply leaves a visible in-flight row
    // rather than a false success; the loser returns the persisted state without
    // dispatching.
    const claimed = await this.storage.updateMemoryProposalStatus({
      id: approved.id,
      expected_status: ['approved'],
      status: 'applying',
    });
    if (claimed === null) {
      const current = (await this.storage.getMemoryProposal(approved.id)) ?? approved;
      return { proposal: current, appliedResult: resultFor(current) };
    }

    const appliedAt = Date.now();

    // Only the forget itself (the irreversible side effect) decides success vs
    // failure. If it throws, nothing was deleted, so record `failed`.
    let outcome: ApplyOutcome;
    try {
      outcome = await this.dispatcher.dispatch(claimed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Memory forget apply failed for ${approved.id}: ${message}`);
      const appliedResult: AppliedResult = {
        success: false,
        error: message,
        details: { proposal_id: approved.id },
      };
      const updated = await this.storage.updateMemoryProposalStatus({
        id: approved.id,
        status: 'failed',
        applied_at: appliedAt,
        applied_result: appliedResult,
      });
      await this.appendAudit(approved.id, 'failed', { error: message }, context).catch(
        () => undefined,
      );
      return { proposal: updated ?? claimed, appliedResult };
    }

    // The forget succeeded and is durable. Finalize + audit are best-effort from
    // here: a bookkeeping error must never re-record an already-applied forget as
    // failed. We hold the exclusive `applying` claim, so the finalize is
    // unconditional.
    const appliedResult: AppliedResult = {
      success: true,
      details: {
        ...outcome.details,
        actualAffected: outcome.actualAffected,
        durationMs: outcome.durationMs,
      },
    };
    let updated: StoredMemoryProposal | null = null;
    try {
      updated = await this.storage.updateMemoryProposalStatus({
        id: approved.id,
        status: 'applied',
        applied_at: appliedAt,
        applied_result: appliedResult,
      });
      await this.appendAudit(approved.id, 'applied', appliedResult.details ?? null, context);
    } catch (err) {
      this.logger.warn(
        `Memory forget applied for ${approved.id} but finalize bookkeeping failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { proposal: updated ?? claimed, appliedResult };
  }

  private async appendAudit(
    proposalId: string,
    eventType: 'applied' | 'failed',
    eventPayload: Record<string, unknown> | null,
    context: MemoryApplyContext,
  ): Promise<void> {
    await this.storage.appendMemoryProposalAudit({
      id: randomUUID(),
      proposal_id: proposalId,
      event_type: eventType,
      event_payload: eventPayload,
      event_at: Date.now(),
      actor: context.actor,
      actor_source: context.actorSource,
    });
  }
}

function resultFor(proposal: StoredMemoryProposal): AppliedResult {
  if (proposal.status === 'applied') {
    return proposal.applied_result ?? { success: true };
  }
  if (proposal.status === 'failed') {
    return proposal.applied_result ?? { success: false };
  }
  return proposal.applied_result ?? { success: false, details: { status: proposal.status } };
}
