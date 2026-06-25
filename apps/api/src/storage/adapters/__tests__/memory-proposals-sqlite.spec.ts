import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../sqlite.adapter';
import type { CreateMemoryProposalInput, MemoryForgetPayload } from '@betterdb/shared';

describe('Memory proposal storage (SQLite)', () => {
  let storage: SqliteAdapter;
  let dbPath: string;
  const CONNECTION_ID = 'conn-test';

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `memory-proposals-${randomUUID()}.db`);
    storage = new SqliteAdapter({ filepath: dbPath });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  const build = (
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
      reasoning: 'removing a memory the user asked to delete',
      proposed_by: 'agent:test',
      ...common,
    };
  };

  it('round-trips a proposal through SQLite with JSON payload intact', async () => {
    const input = build({
      proposal_payload: { target_kind: 'scope', scope: { threadId: 't1' }, tags: ['pref'] },
    });
    const created = await storage.createMemoryProposal(input);
    expect(created.status).toBe('pending');
    expect(created.proposal_payload).toEqual({
      target_kind: 'scope',
      scope: { threadId: 't1' },
      tags: ['pref'],
    });

    const fetched = await storage.getMemoryProposal(input.id);
    expect(fetched?.proposal_payload).toEqual(created.proposal_payload);
    expect(fetched?.applied_result).toBeNull();
  });

  it('lists by status and store_name, newest first', async () => {
    await storage.createMemoryProposal(build({ proposed_at: 100 }));
    const newer = build({
      proposed_at: 200,
      proposal_payload: { target_kind: 'id', memory_id: 'mem-2' },
    });
    await storage.createMemoryProposal(newer);

    const pending = await storage.listMemoryProposals({
      connection_id: CONNECTION_ID,
      status: 'pending',
      store_name: 'betterdb_ac',
    });
    expect(pending[0].id).toBe(newer.id);
    expect(pending).toHaveLength(2);
  });

  it('applies the optimistic expected_status guard on update', async () => {
    const input = build();
    await storage.createMemoryProposal(input);

    const wrong = await storage.updateMemoryProposalStatus({
      id: input.id,
      expected_status: ['approved'],
      status: 'applied',
    });
    expect(wrong).toBeNull();

    const approved = await storage.updateMemoryProposalStatus({
      id: input.id,
      expected_status: ['pending'],
      status: 'approved',
      reviewed_by: 'human',
      reviewed_at: 123,
    });
    expect(approved?.status).toBe('approved');

    const applied = await storage.updateMemoryProposalStatus({
      id: input.id,
      expected_status: ['approved'],
      status: 'applied',
      applied_at: 456,
      applied_result: { success: true, details: { actualAffected: 1 } },
    });
    expect(applied?.status).toBe('applied');
    expect(applied?.applied_result).toEqual({ success: true, details: { actualAffected: 1 } });
  });

  it('stores and reads audit events chronologically', async () => {
    const input = build();
    await storage.createMemoryProposal(input);
    await storage.appendMemoryProposalAudit({
      id: randomUUID(),
      proposal_id: input.id,
      event_type: 'approved',
      event_at: 200,
      actor: 'human',
      actor_source: 'mcp',
    });
    await storage.appendMemoryProposalAudit({
      id: randomUUID(),
      proposal_id: input.id,
      event_type: 'applied',
      event_payload: { actualAffected: 1 },
      event_at: 100,
      actor: null,
      actor_source: 'system',
    });

    const audit = await storage.getMemoryProposalAudit(input.id);
    expect(audit.map((a) => a.event_type)).toEqual(['applied', 'approved']);
    expect(audit[0].event_payload).toEqual({ actualAffected: 1 });
  });

  it('expires pending proposals past their expiry, returning the rows', async () => {
    const stale = build({ proposed_at: 1, expires_at: 100 });
    const fresh = build({
      proposed_at: 1,
      expires_at: 10_000,
      proposal_payload: { target_kind: 'id', memory_id: 'mem-2' },
    });
    await storage.createMemoryProposal(stale);
    await storage.createMemoryProposal(fresh);

    const expired = await storage.expireMemoryProposalsBefore(500);
    expect(expired.map((p) => p.id)).toEqual([stale.id]);
    expect(expired[0].status).toBe('expired');
    expect((await storage.getMemoryProposal(fresh.id))?.status).toBe('pending');
    expect(await storage.expireMemoryProposalsBefore(500)).toEqual([]);
  });
});
