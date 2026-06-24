import { randomUUID } from 'crypto';
import { MemoryAdapter } from '@app/storage/adapters/memory.adapter';
import { MemoryProposalService } from '../memory-proposal.service';
import { MemoryApplyService } from '../memory-apply.service';
import type { MemoryApplyDispatcher, ApplyOutcome } from '../memory-apply.dispatcher';
import { MemoryExpirationCron } from '../memory-expiration.cron';
import {
  MemoryProposalValidationError,
  DuplicatePendingMemoryProposalError,
  MemoryProposalNotFoundError,
  MemoryProposalNotPendingError,
} from '../errors';

const CONNECTION_ID = 'conn-1';
const STORE = 'betterdb_ac';
const REASON = 'user explicitly asked to delete this preference';

function build(outcome?: ApplyOutcome) {
  const storage = new MemoryAdapter();
  const dispatch = jest.fn(
    async (): Promise<ApplyOutcome> =>
      outcome ?? { actualAffected: 1, durationMs: 3, details: { target_kind: 'id' } },
  );
  const dispatcher = { dispatch } as unknown as MemoryApplyDispatcher;
  const applyService = new MemoryApplyService(storage, dispatcher);
  const service = new MemoryProposalService(storage, applyService);
  return { storage, service, applyService, dispatch };
}

describe('MemoryProposalService.proposeForget', () => {
  it('rejects reasoning shorter than the minimum', async () => {
    const { service } = build();
    await expect(
      service.proposeForget(CONNECTION_ID, { storeName: STORE, reasoning: 'too short', memoryId: 'm1' }),
    ).rejects.toBeInstanceOf(MemoryProposalValidationError);
  });

  it('rejects a scope target with no filter', async () => {
    const { service } = build();
    await expect(
      service.proposeForget(CONNECTION_ID, { storeName: STORE, reasoning: REASON, scope: {} }),
    ).rejects.toBeInstanceOf(MemoryProposalValidationError);
  });

  it('persists a pending proposal and records a proposed audit event', async () => {
    const { service, storage } = build();
    const { proposal } = await service.proposeForget(CONNECTION_ID, {
      storeName: STORE,
      reasoning: REASON,
      memoryId: 'm1',
    });
    expect(proposal.status).toBe('pending');
    expect(proposal.proposal_payload).toEqual({ target_kind: 'id', memory_id: 'm1' });

    const audit = await storage.getMemoryProposalAudit(proposal.id);
    expect(audit.map((a) => a.event_type)).toEqual(['proposed']);
  });

  it('rejects a duplicate pending proposal for the same target', async () => {
    const { service } = build();
    await service.proposeForget(CONNECTION_ID, { storeName: STORE, reasoning: REASON, memoryId: 'm1' });
    await expect(
      service.proposeForget(CONNECTION_ID, { storeName: STORE, reasoning: REASON, memoryId: 'm1' }),
    ).rejects.toBeInstanceOf(DuplicatePendingMemoryProposalError);
  });
});

describe('MemoryProposalService.approve', () => {
  it('approves, applies, and is idempotent on re-approve', async () => {
    const { service, storage, dispatch } = build();
    const { proposal } = await service.proposeForget(CONNECTION_ID, {
      storeName: STORE,
      reasoning: REASON,
      memoryId: 'm1',
    });

    const first = await service.approve({ proposalId: proposal.id, actor: 'human', actorSource: 'mcp' });
    expect(first.proposal.status).toBe('applied');
    expect(first.appliedResult.success).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const second = await service.approve({ proposalId: proposal.id, actor: 'human', actorSource: 'mcp' });
    expect(second.proposal.status).toBe('applied');
    expect(dispatch).toHaveBeenCalledTimes(1);

    const audit = await storage.getMemoryProposalAudit(proposal.id);
    expect(audit.map((a) => a.event_type)).toEqual(['proposed', 'approved', 'applied']);
  });

  it('marks the proposal failed when the apply throws', async () => {
    const storage = new MemoryAdapter();
    const dispatcher = {
      dispatch: jest.fn(async () => {
        throw new Error('valkey down');
      }),
    } as unknown as MemoryApplyDispatcher;
    const service = new MemoryProposalService(storage, new MemoryApplyService(storage, dispatcher));
    const { proposal } = await service.proposeForget(CONNECTION_ID, {
      storeName: STORE,
      reasoning: REASON,
      memoryId: 'm1',
    });

    const result = await service.approve({ proposalId: proposal.id, actor: null, actorSource: 'mcp' });
    expect(result.proposal.status).toBe('failed');
    expect(result.appliedResult.success).toBe(false);
    expect(result.appliedResult.error).toContain('valkey down');
  });

  it('throws when the proposal does not exist', async () => {
    const { service } = build();
    await expect(
      service.approve({ proposalId: 'missing', actor: null, actorSource: 'mcp' }),
    ).rejects.toBeInstanceOf(MemoryProposalNotFoundError);
  });

  it('claims the proposal so a concurrent approve cannot dispatch the forget twice', async () => {
    const { service, storage, applyService, dispatch } = build();
    const { proposal } = await service.proposeForget(CONNECTION_ID, {
      storeName: STORE,
      reasoning: REASON,
      memoryId: 'm1',
    });
    const approved = await storage.updateMemoryProposalStatus({
      id: proposal.id,
      expected_status: ['pending'],
      status: 'approved',
    });

    // Two callers race with the same stale "approved" snapshot.
    const [a, b] = await Promise.all([
      applyService.apply(approved!, { actor: null, actorSource: 'mcp' }),
      applyService.apply(approved!, { actor: null, actorSource: 'mcp' }),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const final = await storage.getMemoryProposal(proposal.id);
    expect(final?.status).toBe('applied');
    // Exactly one caller drove the apply to completion; the loser never re-ran forget.
    expect([a.proposal.status, b.proposal.status]).toContain('applied');
  });
});

describe('MemoryProposalService.reject', () => {
  it('rejects a pending proposal and records the audit', async () => {
    const { service, storage } = build();
    const { proposal } = await service.proposeForget(CONNECTION_ID, {
      storeName: STORE,
      reasoning: REASON,
      memoryId: 'm1',
    });
    const rejected = await service.reject({
      proposalId: proposal.id,
      reason: 'not stale',
      actor: 'human',
      actorSource: 'mcp',
    });
    expect(rejected.status).toBe('rejected');
    const audit = await storage.getMemoryProposalAudit(proposal.id);
    expect(audit.map((a) => a.event_type)).toEqual(['proposed', 'rejected']);
  });

  it('throws when rejecting a non-pending proposal', async () => {
    const { service } = build();
    const { proposal } = await service.proposeForget(CONNECTION_ID, {
      storeName: STORE,
      reasoning: REASON,
      memoryId: 'm1',
    });
    await service.approve({ proposalId: proposal.id, actor: 'human', actorSource: 'mcp' });
    await expect(
      service.reject({ proposalId: proposal.id, actor: 'human', actorSource: 'mcp' }),
    ).rejects.toBeInstanceOf(MemoryProposalNotPendingError);
  });
});

describe('MemoryProposalService.expireProposals', () => {
  async function seedExpired(storage: MemoryAdapter, expiresAt: number) {
    return storage.createMemoryProposal({
      id: randomUUID(),
      connection_id: CONNECTION_ID,
      store_name: STORE,
      proposal_type: 'forget',
      proposal_payload: { target_kind: 'id', memory_id: 'm1' },
      reasoning: REASON,
      proposed_by: null,
      proposed_at: 1,
      expires_at: expiresAt,
    });
  }

  it('expires stale pending proposals and audits each as expired', async () => {
    const { service, storage } = build();
    const stale = await seedExpired(storage, 100);

    const count = await service.expireProposals(500);
    expect(count).toBe(1);
    expect((await storage.getMemoryProposal(stale.id))?.status).toBe('expired');
    const audit = await storage.getMemoryProposalAudit(stale.id);
    expect(audit.map((a) => a.event_type)).toContain('expired');
  });

  it('the cron tick delegates to expireProposals with its clock', async () => {
    const { service, storage } = build();
    await seedExpired(storage, 100);
    const cron = new MemoryExpirationCron(service);
    cron.configureForTesting({ now: () => 500 });

    expect(await cron.tick()).toBe(1);
  });
});
