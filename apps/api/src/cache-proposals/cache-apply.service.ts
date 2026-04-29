import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  type ActorSource,
  type AppliedResult,
  type StoredCacheProposal,
} from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { CacheApplyDispatcher } from './cache-apply.dispatcher';
import { ApplyFailedError } from './errors';

const ESTIMATED_AFFECTED_OVERSHOOT_FACTOR = 10;

export interface ApplyContext {
  actor: string | null;
  actorSource: ActorSource;
}

export interface ApplyResult {
  proposal: StoredCacheProposal;
  appliedResult: AppliedResult;
}

@Injectable()
export class CacheApplyService {
  private readonly logger = new Logger(CacheApplyService.name);

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly dispatcher: CacheApplyDispatcher,
  ) {}

  /**
   * Idempotently applies an approved proposal. Re-running on an already
   * applied/failed proposal short-circuits and returns the existing result.
   */
  async apply(approved: StoredCacheProposal, context: ApplyContext): Promise<ApplyResult> {
    if (approved.status === 'applied' || approved.status === 'failed') {
      const appliedResult = approved.applied_result ?? { success: approved.status === 'applied' };
      return { proposal: approved, appliedResult };
    }

    let outcome: Awaited<ReturnType<CacheApplyDispatcher['dispatch']>>;
    try {
      outcome = await this.dispatcher.dispatch(approved);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failedDetails =
        err instanceof ApplyFailedError && err.details ? err.details : { error: message };
      const appliedResult: AppliedResult = {
        success: false,
        error: message,
        details: failedDetails,
      };
      const failed = await this.storage.updateCacheProposalStatus({
        id: approved.id,
        expected_status: ['approved'],
        status: 'failed',
        applied_at: Date.now(),
        applied_result: appliedResult,
      });
      const finalProposal = failed ?? approved;
      await this.appendAudit(finalProposal, 'failed', appliedResult, context);
      return { proposal: finalProposal, appliedResult };
    }

    const estimated = estimatedAffectedOf(approved);
    const overshoot =
      typeof outcome.actualAffected === 'number' &&
      typeof estimated === 'number' &&
      estimated > 0 &&
      outcome.actualAffected > estimated * ESTIMATED_AFFECTED_OVERSHOOT_FACTOR;

    if (overshoot) {
      this.logger.warn(
        `Proposal ${approved.id} invalidate overshoot: actual=${outcome.actualAffected} >> estimated=${estimated}`,
      );
    }

    const appliedResult: AppliedResult = {
      success: true,
      details: {
        ...outcome.details,
        ...(outcome.actualAffected !== undefined
          ? { actual_affected: outcome.actualAffected }
          : {}),
        duration_ms: outcome.durationMs,
        ...(overshoot ? { overshoot: true } : {}),
      },
    };

    const applied = await this.storage.updateCacheProposalStatus({
      id: approved.id,
      expected_status: ['approved'],
      status: 'applied',
      applied_at: Date.now(),
      applied_result: appliedResult,
    });
    if (applied === null) {
      this.logger.warn(
        `Proposal ${approved.id} status changed concurrently — apply work was performed but DB update was skipped`,
      );
      return { proposal: approved, appliedResult };
    }
    await this.appendAudit(applied, 'applied', appliedResult, context);
    return { proposal: applied, appliedResult };
  }

  private async appendAudit(
    proposal: StoredCacheProposal,
    eventType: 'applied' | 'failed',
    appliedResult: AppliedResult,
    context: ApplyContext,
  ): Promise<void> {
    try {
      await this.storage.appendCacheProposalAudit({
        id: randomUUID(),
        proposal_id: proposal.id,
        event_type: eventType,
        event_payload: { applied_result: appliedResult },
        event_at: Date.now(),
        actor: context.actor,
        actor_source: context.actorSource,
      });
    } catch (err) {
      this.logger.error(
        `Failed to write ${eventType} audit for proposal ${proposal.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function estimatedAffectedOf(proposal: StoredCacheProposal): number | undefined {
  if (proposal.proposal_type !== 'invalidate') {
    return undefined;
  }
  return proposal.proposal_payload.estimated_affected;
}
