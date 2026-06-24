import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { StoredMemoryProposal, AppliedResult, ActorSource } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { MemoryApplyDispatcher } from './memory-apply.dispatcher';

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
    // approvals cannot run the forget twice: only the first `approved -> applied`
    // transition wins; the loser returns the persisted result without dispatching.
    const claimed = await this.storage.updateMemoryProposalStatus({
      id: approved.id,
      expected_status: ['approved'],
      status: 'applied',
    });
    if (claimed === null) {
      const current = (await this.storage.getMemoryProposal(approved.id)) ?? approved;
      const cached = current.applied_result ?? { success: current.status === 'applied' };
      return { proposal: current, appliedResult: cached };
    }

    const appliedAt = Date.now();
    try {
      const outcome = await this.dispatcher.dispatch(claimed);
      const appliedResult: AppliedResult = {
        success: true,
        details: {
          ...outcome.details,
          actualAffected: outcome.actualAffected,
          durationMs: outcome.durationMs,
        },
      };
      const updated = await this.storage.updateMemoryProposalStatus({
        id: approved.id,
        expected_status: ['applied'],
        status: 'applied',
        applied_at: appliedAt,
        applied_result: appliedResult,
      });
      await this.appendAudit(approved.id, 'applied', appliedResult.details ?? null, context);
      return { proposal: updated ?? claimed, appliedResult };
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
        expected_status: ['applied'],
        status: 'failed',
        applied_at: appliedAt,
        applied_result: appliedResult,
      });
      await this.appendAudit(approved.id, 'failed', { error: message }, context);
      return { proposal: updated ?? claimed, appliedResult };
    }
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
