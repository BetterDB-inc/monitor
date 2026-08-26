import { MemoryApplyService } from '../memory-apply.service';
import { MemoryApplyDispatcher } from '../memory-apply.dispatcher';
import {
  APPLY_DISPATCH_TIMEOUT_MS,
  STALE_APPLY_AFTER_MS,
  MemoryApplyTimeoutError,
} from '../apply-timing';
import type { StoredMemoryProposal } from '@betterdb/shared';

function proposal(over: Partial<StoredMemoryProposal> = {}): StoredMemoryProposal {
  return {
    id: 'p-1',
    connection_id: 'conn-1',
    store_name: 'store-1',
    reasoning: null,
    status: 'approved',
    proposed_by: null,
    proposed_at: 0,
    reviewed_by: null,
    reviewed_at: null,
    applying_at: null,
    applied_at: null,
    applied_result: null,
    expires_at: 10_000,
    proposal_type: 'forget',
    proposal_payload: { target_kind: 'id', memory_id: 'mem-1' },
    target_discriminator: 'id:mem-1',
    ...over,
  } as StoredMemoryProposal;
}

const context = { actor: 'op', actorSource: 'ui' as const };

describe('apply vs stale sweep', () => {
  function make(options: { sweepTakesRow: boolean; dispatch: jest.Mock }) {
    const swept = proposal({
      status: 'failed',
      applying_at: 1_000,
      applied_at: 2_000,
      applied_result: { success: false, error: 'stale_apply' },
    });

    const storage = {
      updateMemoryProposalStatus: jest.fn(async (input: Record<string, unknown>) => {
        if (input.status === 'applying') {
          return proposal({ status: 'applying', applying_at: 1_000 });
        }
        // The sweep already moved the row out of `applying`, so a guarded
        // finalize matches nothing.
        if (options.sweepTakesRow) {
          return null;
        }
        return proposal({ status: input.status as StoredMemoryProposal['status'] });
      }),
      getMemoryProposal: jest.fn().mockResolvedValue(swept),
      appendMemoryProposalAudit: jest.fn().mockResolvedValue(undefined),
    };
    const dispatcher = { dispatch: options.dispatch } as unknown as MemoryApplyDispatcher;
    return { service: new MemoryApplyService(storage as never, dispatcher), storage, swept };
  }

  it('does not resurrect a swept row into a false success', async () => {
    const dispatch = jest
      .fn()
      .mockResolvedValue({ actualAffected: 1, durationMs: 5, details: { removed: true } });
    const { service, storage, swept } = make({ sweepTakesRow: true, dispatch });

    const result = await service.apply(proposal(), context);

    // The forget really did run, but the sweep already told operators the
    // delete may be partial. The terminal state stands.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.proposal).toBe(swept);
    expect(result.appliedResult.success).toBe(false);

    const finalize = storage.updateMemoryProposalStatus.mock.calls.find(
      ([input]: [Record<string, unknown>]) => input.status === 'applied',
    );
    expect(finalize?.[0].expected_status).toEqual(['applying']);
  });

  it('records the reconciliation so the trail explains the contradiction', async () => {
    const dispatch = jest
      .fn()
      .mockResolvedValue({ actualAffected: 1, durationMs: 5, details: { removed: true } });
    const { service, storage } = make({ sweepTakesRow: true, dispatch });

    await service.apply(proposal(), context);

    expect(storage.appendMemoryProposalAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal_id: 'p-1',
        event_type: 'failed',
        event_payload: expect.objectContaining({ reconciled: 'completed_after_stale_sweep' }),
      }),
    );
  });

  it('guards the failure finalize on applying too', async () => {
    const dispatch = jest.fn().mockRejectedValue(new Error('boom'));
    const { service, storage } = make({ sweepTakesRow: false, dispatch });

    await service.apply(proposal(), context);

    const finalize = storage.updateMemoryProposalStatus.mock.calls.find(
      ([input]: [Record<string, unknown>]) => input.status === 'failed',
    );
    expect(finalize?.[0].expected_status).toEqual(['applying']);
  });

  it('finalizes normally when the sweep did not take the row', async () => {
    const dispatch = jest
      .fn()
      .mockResolvedValue({ actualAffected: 1, durationMs: 5, details: { removed: true } });
    const { service } = make({ sweepTakesRow: false, dispatch });

    const result = await service.apply(proposal(), context);

    expect(result.appliedResult.success).toBe(true);
  });
});

describe('dispatch timeout', () => {
  it('is strictly below the sweep cutoff so the two cannot both claim a row', () => {
    expect(APPLY_DISPATCH_TIMEOUT_MS).toBeLessThan(STALE_APPLY_AFTER_MS);
  });

  it('abandons a forget that outruns the bound', async () => {
    const registry = {
      get: () => ({ getClient: () => ({}) }),
    };
    const dispatcher = new MemoryApplyDispatcher(registry as never);
    dispatcher.configureForTesting({ timeoutMs: 10 });
    jest
      .spyOn(dispatcher as unknown as { run: () => Promise<never> }, 'run')
      .mockImplementation(() => new Promise(() => {}));

    await expect(dispatcher.dispatch(proposal())).rejects.toBeInstanceOf(MemoryApplyTimeoutError);
  });

  it('leaves no timer behind when the forget finishes first', async () => {
    jest.useFakeTimers();
    try {
      const registry = { get: () => ({ getClient: () => ({}) }) };
      const dispatcher = new MemoryApplyDispatcher(registry as never);
      dispatcher.configureForTesting({ timeoutMs: 50_000 });
      const outcome = { actualAffected: 1, durationMs: 1, details: {} };
      jest
        .spyOn(dispatcher as unknown as { run: () => Promise<typeof outcome> }, 'run')
        .mockResolvedValue(outcome);

      await expect(dispatcher.dispatch(proposal())).resolves.toBe(outcome);
      // A surviving 50s timer would hold the event loop open past the suite.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
