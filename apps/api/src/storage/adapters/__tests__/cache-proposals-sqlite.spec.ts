import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../sqlite.adapter';

describe('Cache proposal storage (SQLite)', () => {
  let storage: SqliteAdapter;
  let dbPath: string;
  const CONNECTION_ID = 'conn-test';

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `cache-proposals-${randomUUID()}.db`);
    storage = new SqliteAdapter({ filepath: dbPath });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it('round-trips a semantic threshold_adjust proposal through JSON serialization', async () => {
    const id = randomUUID();
    const created = await storage.createCacheProposal({
      id,
      connection_id: CONNECTION_ID,
      cache_name: 'sc:default',
      cache_type: 'semantic_cache',
      proposal_type: 'threshold_adjust',
      proposal_payload: {
        category: 'faq',
        current_threshold: 0.1,
        new_threshold: 0.05,
      },
      reasoning: 'tightening faq threshold',
      proposed_by: 'agent:test',
    });

    expect(created.id).toBe(id);
    expect(created.status).toBe('pending');
    expect(created.reasoning).toBe('tightening faq threshold');

    const fetched = await storage.getCacheProposal(id);
    expect(fetched).not.toBeNull();
    if (
      fetched!.cache_type === 'semantic_cache' &&
      fetched!.proposal_type === 'threshold_adjust'
    ) {
      expect(fetched!.proposal_payload.category).toBe('faq');
      expect(fetched!.proposal_payload.new_threshold).toBe(0.05);
    } else {
      throw new Error('discriminated union narrowing failed');
    }
  });

  it('rejects invalid (cache_type, proposal_type) combinations via CHECK constraint', async () => {
    const invalidInput = {
      id: randomUUID(),
      connection_id: CONNECTION_ID,
      cache_name: 'sc:default',
      cache_type: 'semantic_cache',
      proposal_type: 'tool_ttl_adjust',
      proposal_payload: {
        tool_name: 'whatever',
        current_ttl_seconds: 100,
        new_ttl_seconds: 200,
      },
    } as unknown as Parameters<typeof storage.createCacheProposal>[0];
    await expect(storage.createCacheProposal(invalidInput)).rejects.toThrow();
  });

  it('persists applied_result JSON and audit events with payloads', async () => {
    const proposalId = randomUUID();
    await storage.createCacheProposal({
      id: proposalId,
      connection_id: CONNECTION_ID,
      cache_name: 'ac:default',
      cache_type: 'agent_cache',
      proposal_type: 'invalidate',
      proposal_payload: {
        filter_kind: 'tool',
        filter_value: 'get_weather',
        estimated_affected: 10,
      },
    });

    const applied = await storage.updateCacheProposalStatus({
      id: proposalId,
      status: 'applied',
      applied_at: 5_000,
      applied_result: { success: true, details: { keys_deleted: 7 } },
    });
    expect(applied!.applied_result).toEqual({ success: true, details: { keys_deleted: 7 } });

    await storage.appendCacheProposalAudit({
      id: randomUUID(),
      proposal_id: proposalId,
      event_type: 'applied',
      event_payload: { keys_deleted: 7 },
      actor: 'system',
      actor_source: 'system',
    });
    const audit = await storage.getCacheProposalAudit(proposalId);
    expect(audit).toHaveLength(1);
    expect(audit[0].event_payload).toEqual({ keys_deleted: 7 });
  });

  it('expires only pending proposals past expiry (partial index path)', async () => {
    const expiredId = randomUUID();
    const liveId = randomUUID();
    await storage.createCacheProposal({
      id: expiredId,
      connection_id: CONNECTION_ID,
      cache_name: 'sc:default',
      cache_type: 'semantic_cache',
      proposal_type: 'threshold_adjust',
      proposal_payload: { category: null, current_threshold: 0.1, new_threshold: 0.08 },
      expires_at: 100,
    });
    await storage.createCacheProposal({
      id: liveId,
      connection_id: CONNECTION_ID,
      cache_name: 'sc:default',
      cache_type: 'semantic_cache',
      proposal_type: 'threshold_adjust',
      proposal_payload: { category: null, current_threshold: 0.1, new_threshold: 0.08 },
      expires_at: 9_999_999_999_999,
    });

    const result = await storage.expireCacheProposalsBefore(1_000);
    expect(result.map((p) => p.id)).toEqual([expiredId]);

    const stillLive = await storage.getCacheProposal(liveId);
    expect(stillLive!.status).toBe('pending');
  });
});
