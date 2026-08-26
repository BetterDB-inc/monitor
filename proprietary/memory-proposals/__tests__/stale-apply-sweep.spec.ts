import { MemoryProposalService } from '../memory-proposal.service';
import { MemoryExpirationCron } from '../memory-expiration.cron';
import type { StoredMemoryProposal } from '@betterdb/shared';

function proposal(over: Partial<StoredMemoryProposal> = {}): StoredMemoryProposal {
  return {
    id: 'p-1',
    connection_id: 'conn-1',
    store_name: 'store-1',
    reasoning: null,
    status: 'applying',
    proposed_by: null,
    proposed_at: 0,
    reviewed_by: null,
    reviewed_at: null,
    applying_at: 1_000,
    applied_at: null,
    applied_result: null,
    expires_at: 10_000,
    proposal_type: 'forget',
    proposal_payload: { target_kind: 'id', memory_id: 'mem-1' },
    target_discriminator: 'id:mem-1',
    ...over,
  } as StoredMemoryProposal;
}

describe('MemoryProposalService.failStaleApplyingProposals', () => {
  function make(swept: StoredMemoryProposal[]) {
    const storage = {
      failStaleApplyingMemoryProposalsBefore: jest.fn().mockResolvedValue(swept),
      appendMemoryProposalAudit: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MemoryProposalService(storage as never);
    return { service, storage };
  }

  it('returns how many rows it swept', async () => {
    const { service } = make([proposal(), proposal({ id: 'p-2' })]);

    expect(await service.failStaleApplyingProposals(2_000)).toBe(2);
  });

  it('records an audit entry naming the stale-apply reason', async () => {
    const { service, storage } = make([proposal()]);

    await service.failStaleApplyingProposals(2_000);

    expect(storage.appendMemoryProposalAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal_id: 'p-1',
        event_type: 'failed',
        event_payload: { reason: 'stale_apply', applying_at: 1_000 },
      }),
    );
  });

  it('still reports the sweep when the audit write fails', async () => {
    const { service, storage } = make([proposal()]);
    storage.appendMemoryProposalAudit.mockRejectedValue(new Error('audit down'));

    // Losing the audit trail must not leave the row stuck in `applying`, which
    // is the state this whole sweep exists to clear.
    await expect(service.failStaleApplyingProposals(2_000)).resolves.toBe(1);
  });

  it('does nothing when there is nothing stale', async () => {
    const { service, storage } = make([]);

    expect(await service.failStaleApplyingProposals(2_000)).toBe(0);
    expect(storage.appendMemoryProposalAudit).not.toHaveBeenCalled();
  });
});

describe('MemoryExpirationCron', () => {
  it('runs both sweeps on one tick, with the stale cutoff behind now', async () => {
    const service = {
      expireProposals: jest.fn().mockResolvedValue(0),
      failStaleApplyingProposals: jest.fn().mockResolvedValue(0),
    };
    const cron = new MemoryExpirationCron(service as never);
    cron.configureForTesting({ now: () => 1_000_000 });

    await cron.tick();

    expect(service.expireProposals).toHaveBeenCalledWith(1_000_000, 'system');
    const [cutoff] = service.failStaleApplyingProposals.mock.calls[0];
    // An in-flight apply gets a grace window; sweeping at `now` would fail
    // every apply the instant it was claimed.
    expect(cutoff).toBeLessThan(1_000_000);
  });
});
