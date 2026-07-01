import { randomUUID } from 'crypto';
import { MemoryAdapter } from '../memory.adapter';
import type { CreateMemoryProposalInput, MemoryForgetPayload } from '@betterdb/shared';

const CONNECTION_ID = 'conn-test';

const buildForget = (
  overrides: Partial<Omit<CreateMemoryProposalInput, 'proposal_type' | 'proposal_payload'>> & {
    proposal_payload?: MemoryForgetPayload;
  } = {},
): CreateMemoryProposalInput => {
  const { proposal_payload, ...common } = overrides;
  return {
    id: randomUUID(),
    connection_id: CONNECTION_ID,
    store_name: 'betterdb_ac',
    proposal_type: 'forget',
    proposal_payload: proposal_payload ?? { target_kind: 'id', memory_id: 'mem-1' },
    reasoning: 'cleaning up stale user preference memory',
    proposed_by: 'agent:test',
    ...common,
  };
};

describe('MemoryAdapter memory proposals', () => {
  it('creates and reads back a proposal with defaults', async () => {
    const adapter = new MemoryAdapter();
    const input = buildForget();
    const created = await adapter.createMemoryProposal(input);

    expect(created.status).toBe('pending');
    expect(created.proposed_at).toBeGreaterThan(0);
    expect(created.expires_at).toBeGreaterThan(created.proposed_at);
    expect(created.applied_result).toBeNull();

    const fetched = await adapter.getMemoryProposal(input.id);
    expect(fetched?.id).toBe(input.id);
    expect(fetched?.proposal_payload).toEqual({ target_kind: 'id', memory_id: 'mem-1' });
  });

  it('rejects a duplicate pending proposal for the same target', async () => {
    const adapter = new MemoryAdapter();
    await adapter.createMemoryProposal(buildForget());
    await expect(adapter.createMemoryProposal(buildForget())).rejects.toThrow(/UNIQUE/);
  });

  it('allows a second proposal once the first is no longer pending', async () => {
    const adapter = new MemoryAdapter();
    const first = buildForget();
    await adapter.createMemoryProposal(first);
    await adapter.updateMemoryProposalStatus({
      id: first.id,
      expected_status: ['pending'],
      status: 'rejected',
    });
    await expect(adapter.createMemoryProposal(buildForget())).resolves.toBeTruthy();
  });

  it('distinguishes scope targets from id targets', async () => {
    const adapter = new MemoryAdapter();
    await adapter.createMemoryProposal(buildForget());
    const scoped = buildForget({
      proposal_payload: { target_kind: 'scope', scope: { threadId: 't1' }, tags: ['pref'] },
    });
    await expect(adapter.createMemoryProposal(scoped)).resolves.toBeTruthy();
  });

  it('lists by status and store_name, newest first', async () => {
    const adapter = new MemoryAdapter();
    const a = buildForget({ proposed_at: 100 });
    const b = buildForget({
      proposed_at: 200,
      proposal_payload: { target_kind: 'id', memory_id: 'mem-2' },
    });
    await adapter.createMemoryProposal(a);
    await adapter.createMemoryProposal(b);

    const pending = await adapter.listMemoryProposals({
      connection_id: CONNECTION_ID,
      status: 'pending',
      store_name: 'betterdb_ac',
    });
    expect(pending.map((p) => p.id)).toEqual([b.id, a.id]);

    const other = await adapter.listMemoryProposals({
      connection_id: CONNECTION_ID,
      store_name: 'someone_else',
    });
    expect(other).toEqual([]);
  });

  it('enforces expected_status on update (optimistic guard)', async () => {
    const adapter = new MemoryAdapter();
    const input = buildForget();
    await adapter.createMemoryProposal(input);

    const wrong = await adapter.updateMemoryProposalStatus({
      id: input.id,
      expected_status: ['approved'],
      status: 'applied',
    });
    expect(wrong).toBeNull();

    const ok = await adapter.updateMemoryProposalStatus({
      id: input.id,
      expected_status: ['pending'],
      status: 'approved',
      reviewed_by: 'human',
      reviewed_at: 123,
    });
    expect(ok?.status).toBe('approved');
    expect(ok?.reviewed_by).toBe('human');
  });

  it('appends and reads audit events in chronological order', async () => {
    const adapter = new MemoryAdapter();
    const input = buildForget();
    await adapter.createMemoryProposal(input);
    await adapter.appendMemoryProposalAudit({
      id: randomUUID(),
      proposal_id: input.id,
      event_type: 'approved',
      event_payload: null,
      event_at: 200,
      actor: 'human',
      actor_source: 'mcp',
    });
    await adapter.appendMemoryProposalAudit({
      id: randomUUID(),
      proposal_id: input.id,
      event_type: 'applied',
      event_payload: { actualAffected: 1 },
      event_at: 100,
      actor: null,
      actor_source: 'system',
    });

    const audit = await adapter.getMemoryProposalAudit(input.id);
    expect(audit.map((a) => a.event_type)).toEqual(['applied', 'approved']);
  });

  it('expires only pending proposals past their expiry', async () => {
    const adapter = new MemoryAdapter();
    const stale = buildForget({ proposed_at: 1, expires_at: 100 });
    const fresh = buildForget({
      proposed_at: 1,
      expires_at: 10_000,
      proposal_payload: { target_kind: 'id', memory_id: 'mem-2' },
    });
    await adapter.createMemoryProposal(stale);
    await adapter.createMemoryProposal(fresh);

    const expired = await adapter.expireMemoryProposalsBefore(500);
    expect(expired.map((p) => p.id)).toEqual([stale.id]);
    expect(expired[0].status).toBe('expired');
    expect((await adapter.getMemoryProposal(fresh.id))?.status).toBe('pending');

    // Idempotent: a second sweep finds nothing already-expired.
    expect(await adapter.expireMemoryProposalsBefore(500)).toEqual([]);
  });

  it('fails only applying proposals whose reviewed_at is past the stale cutoff', async () => {
    const adapter = new MemoryAdapter();
    const stale = buildForget({ proposed_at: 1, expires_at: 10_000 });
    const fresh = buildForget({
      proposed_at: 1,
      expires_at: 10_000,
      proposal_payload: { target_kind: 'id', memory_id: 'mem-2' },
    });
    await adapter.createMemoryProposal(stale);
    await adapter.createMemoryProposal(fresh);
    await adapter.updateMemoryProposalStatus({
      id: stale.id,
      expected_status: ['pending'],
      status: 'applying',
      reviewed_at: 100,
    });
    await adapter.updateMemoryProposalStatus({
      id: fresh.id,
      expected_status: ['pending'],
      status: 'applying',
      reviewed_at: 1_000,
    });

    const failed = await adapter.failStaleApplyingMemoryProposalsBefore(500);
    expect(failed.map((p) => p.id)).toEqual([stale.id]);
    expect(failed[0].status).toBe('failed');
    expect(failed[0].applied_result).toEqual({
      success: false,
      error: 'stale_apply',
      details: { reviewed_at: 100 },
    });
    expect((await adapter.getMemoryProposal(fresh.id))?.status).toBe('applying');

    expect(await adapter.failStaleApplyingMemoryProposalsBefore(500)).toEqual([]);
  });
});
