import { randomUUID } from 'crypto';
import { MemoryAdapter } from '../memory.adapter';
import type {
  CreateCacheProposalInput,
  AppendProposalAuditInput,
  StoredCacheProposal,
} from '@betterdb/shared';
import { PROPOSAL_DEFAULT_EXPIRY_MS } from '@betterdb/shared';

const CONNECTION_ID = 'conn-test';

type SemanticThresholdInput = Extract<
  CreateCacheProposalInput,
  { cache_type: 'semantic_cache'; proposal_type: 'threshold_adjust' }
>;
type AgentTtlInput = Extract<
  CreateCacheProposalInput,
  { cache_type: 'agent_cache'; proposal_type: 'tool_ttl_adjust' }
>;

type CommonOverrides = Partial<
  Omit<SemanticThresholdInput, 'cache_type' | 'proposal_type' | 'proposal_payload'>
>;

const buildSemanticThreshold = (
  overrides: CommonOverrides & { proposal_payload?: SemanticThresholdInput['proposal_payload'] } = {},
): SemanticThresholdInput => {
  const { proposal_payload, ...common } = overrides;
  return {
    id: randomUUID(),
    connection_id: CONNECTION_ID,
    cache_name: 'sc:default',
    cache_type: 'semantic_cache',
    proposal_type: 'threshold_adjust',
    proposal_payload: proposal_payload ?? {
      category: 'faq',
      current_threshold: 0.1,
      new_threshold: 0.08,
    },
    proposed_by: 'agent:test',
    ...common,
  };
};

const buildAgentTtl = (
  overrides: CommonOverrides & { proposal_payload?: AgentTtlInput['proposal_payload'] } = {},
): AgentTtlInput => {
  const { proposal_payload, ...common } = overrides;
  return {
    id: randomUUID(),
    connection_id: CONNECTION_ID,
    cache_name: 'ac:default',
    cache_type: 'agent_cache',
    proposal_type: 'tool_ttl_adjust',
    proposal_payload: proposal_payload ?? {
      tool_name: 'search',
      current_ttl_seconds: 300,
      new_ttl_seconds: 600,
    },
    ...common,
  };
};

describe('Cache proposal storage', () => {
  let storage: MemoryAdapter;

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
  });

  describe('createCacheProposal', () => {
    it('persists a semantic threshold_adjust proposal with defaults', async () => {
      const input = buildSemanticThreshold();
      const before = Date.now();
      const created = await storage.createCacheProposal(input);

      expect(created.id).toBe(input.id);
      expect(created.connection_id).toBe(CONNECTION_ID);
      expect(created.cache_type).toBe('semantic_cache');
      expect(created.proposal_type).toBe('threshold_adjust');
      expect(created.status).toBe('pending');
      expect(created.proposed_at).toBeGreaterThanOrEqual(before);
      expect(created.expires_at).toBeGreaterThanOrEqual(
        created.proposed_at + PROPOSAL_DEFAULT_EXPIRY_MS - 1,
      );
      expect(created.applied_at).toBeNull();
      expect(created.applied_result).toBeNull();
      expect(created.reviewed_at).toBeNull();
      expect(created.reviewed_by).toBeNull();
    });

    it('persists an agent tool_ttl_adjust proposal', async () => {
      const created = await storage.createCacheProposal(buildAgentTtl());
      expect(created.cache_type).toBe('agent_cache');
      expect(created.proposal_type).toBe('tool_ttl_adjust');
      if (created.cache_type === 'agent_cache' && created.proposal_type === 'tool_ttl_adjust') {
        expect(created.proposal_payload.tool_name).toBe('search');
      }
    });

    it('respects explicit proposed_at and expires_at', async () => {
      const proposedAt = 1_000_000;
      const expiresAt = 2_000_000;
      const created = await storage.createCacheProposal(
        buildSemanticThreshold({ proposed_at: proposedAt, expires_at: expiresAt }),
      );
      expect(created.proposed_at).toBe(proposedAt);
      expect(created.expires_at).toBe(expiresAt);
    });

    it('returns a snapshot, not a live reference', async () => {
      const created = await storage.createCacheProposal(buildSemanticThreshold());
      (created.proposal_payload as { current_threshold: number }).current_threshold = 999;
      const fresh = await storage.getCacheProposal(created.id);
      expect(
        (fresh!.proposal_payload as { current_threshold: number }).current_threshold,
      ).toBe(0.1);
    });
  });

  describe('listCacheProposals', () => {
    it('filters by connection_id', async () => {
      await storage.createCacheProposal(buildSemanticThreshold());
      await storage.createCacheProposal(buildSemanticThreshold({ connection_id: 'conn-other' }));

      const result = await storage.listCacheProposals({ connection_id: CONNECTION_ID });
      expect(result).toHaveLength(1);
      expect(result[0].connection_id).toBe(CONNECTION_ID);
    });

    it('filters by status (single and array)', async () => {
      const a = await storage.createCacheProposal(buildSemanticThreshold());
      const b = await storage.createCacheProposal(
        buildSemanticThreshold({
          proposal_payload: { category: 'support', current_threshold: 0.1, new_threshold: 0.08 },
        }),
      );
      await storage.updateCacheProposalStatus({ id: b.id, status: 'approved' });

      const pending = await storage.listCacheProposals({ connection_id: CONNECTION_ID, status: 'pending' });
      expect(pending.map((p) => p.id)).toEqual([a.id]);

      const both = await storage.listCacheProposals({
        connection_id: CONNECTION_ID,
        status: ['pending', 'approved'],
      });
      expect(both).toHaveLength(2);
    });

    it('filters by cache_type and proposal_type', async () => {
      await storage.createCacheProposal(buildSemanticThreshold());
      const ttl = await storage.createCacheProposal(buildAgentTtl());

      const agents = await storage.listCacheProposals({
        connection_id: CONNECTION_ID,
        cache_type: 'agent_cache',
      });
      expect(agents.map((p) => p.id)).toEqual([ttl.id]);

      const ttlOnly = await storage.listCacheProposals({
        connection_id: CONNECTION_ID,
        proposal_type: 'tool_ttl_adjust',
      });
      expect(ttlOnly).toHaveLength(1);
    });

    it('orders by proposed_at desc and respects pagination', async () => {
      const old = await storage.createCacheProposal(
        buildSemanticThreshold({
          proposed_at: 100,
          proposal_payload: { category: 'a', current_threshold: 0.1, new_threshold: 0.08 },
        }),
      );
      const mid = await storage.createCacheProposal(
        buildSemanticThreshold({
          proposed_at: 200,
          proposal_payload: { category: 'b', current_threshold: 0.1, new_threshold: 0.08 },
        }),
      );
      const fresh = await storage.createCacheProposal(
        buildSemanticThreshold({
          proposed_at: 300,
          proposal_payload: { category: 'c', current_threshold: 0.1, new_threshold: 0.08 },
        }),
      );

      const all = await storage.listCacheProposals({ connection_id: CONNECTION_ID });
      expect(all.map((p) => p.id)).toEqual([fresh.id, mid.id, old.id]);

      const page2 = await storage.listCacheProposals({
        connection_id: CONNECTION_ID,
        limit: 1,
        offset: 1,
      });
      expect(page2.map((p) => p.id)).toEqual([mid.id]);
    });
  });

  describe('updateCacheProposalStatus', () => {
    it('transitions status and stores reviewer metadata', async () => {
      const created = await storage.createCacheProposal(buildSemanticThreshold());
      const updated = await storage.updateCacheProposalStatus({
        id: created.id,
        status: 'approved',
        reviewed_by: 'user:42',
        reviewed_at: 12345,
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('approved');
      expect(updated!.reviewed_by).toBe('user:42');
      expect(updated!.reviewed_at).toBe(12345);
    });

    it('records applied_at and applied_result on apply', async () => {
      const created = await storage.createCacheProposal(buildSemanticThreshold());
      const updated = await storage.updateCacheProposalStatus({
        id: created.id,
        status: 'applied',
        applied_at: 99999,
        applied_result: { success: true, details: { keys_deleted: 12 } },
      });
      expect(updated!.status).toBe('applied');
      expect(updated!.applied_at).toBe(99999);
      expect(updated!.applied_result?.success).toBe(true);
      expect(updated!.applied_result?.details).toEqual({ keys_deleted: 12 });
    });

    it('persists an edited proposal_payload (edit_and_approve flow)', async () => {
      const created = await storage.createCacheProposal(buildSemanticThreshold());
      const updated = await storage.updateCacheProposalStatus({
        id: created.id,
        status: 'approved',
        proposal_payload: {
          category: 'faq',
          current_threshold: 0.1,
          new_threshold: 0.05,
        },
      });
      const payload = updated!.proposal_payload as { new_threshold: number };
      expect(payload.new_threshold).toBe(0.05);
    });

    it('returns null when proposal does not exist', async () => {
      const updated = await storage.updateCacheProposalStatus({
        id: 'no-such-id',
        status: 'approved',
      });
      expect(updated).toBeNull();
    });
  });

  describe('expireCacheProposalsBefore', () => {
    it('marks pending proposals past expiry as expired and leaves others alone', async () => {
      const expired = await storage.createCacheProposal(
        buildSemanticThreshold({
          expires_at: 100,
          proposal_payload: { category: 'a', current_threshold: 0.1, new_threshold: 0.08 },
        }),
      );
      const fresh = await storage.createCacheProposal(
        buildSemanticThreshold({
          expires_at: 1_000_000_000_000,
          proposal_payload: { category: 'b', current_threshold: 0.1, new_threshold: 0.08 },
        }),
      );
      const approved = await storage.createCacheProposal(
        buildSemanticThreshold({
          expires_at: 100,
          proposal_payload: { category: 'c', current_threshold: 0.1, new_threshold: 0.08 },
        }),
      );
      await storage.updateCacheProposalStatus({ id: approved.id, status: 'approved' });

      const result = await storage.expireCacheProposalsBefore(1_000);

      expect(result.map((p) => p.id)).toEqual([expired.id]);
      expect(result[0].status).toBe('expired');

      const reread = await storage.getCacheProposal(fresh.id);
      expect(reread!.status).toBe('pending');

      const stillApproved = await storage.getCacheProposal(approved.id);
      expect(stillApproved!.status).toBe('approved');
    });
  });

  describe('appendCacheProposalAudit / getCacheProposalAudit', () => {
    it('appends and reads audit events in chronological order', async () => {
      const proposal = await storage.createCacheProposal(buildSemanticThreshold());
      const events: AppendProposalAuditInput[] = [
        {
          id: randomUUID(),
          proposal_id: proposal.id,
          event_type: 'proposed',
          event_at: 100,
          actor_source: 'mcp',
          actor: 'agent:test',
        },
        {
          id: randomUUID(),
          proposal_id: proposal.id,
          event_type: 'approved',
          event_at: 200,
          actor_source: 'ui',
          actor: 'user:1',
          event_payload: { note: 'lgtm' },
        },
      ];
      for (const event of events) {
        await storage.appendCacheProposalAudit(event);
      }

      const audit = await storage.getCacheProposalAudit(proposal.id);
      expect(audit.map((a) => a.event_type)).toEqual(['proposed', 'approved']);
      expect(audit[1].event_payload).toEqual({ note: 'lgtm' });
    });

    it('does not return audit events for other proposals', async () => {
      const a = await storage.createCacheProposal(buildSemanticThreshold());
      const b = await storage.createCacheProposal(
        buildSemanticThreshold({
          proposal_payload: { category: 'support', current_threshold: 0.1, new_threshold: 0.08 },
        }),
      );
      await storage.appendCacheProposalAudit({
        id: randomUUID(),
        proposal_id: a.id,
        event_type: 'proposed',
        actor_source: 'mcp',
      });
      await storage.appendCacheProposalAudit({
        id: randomUUID(),
        proposal_id: b.id,
        event_type: 'proposed',
        actor_source: 'mcp',
      });

      const audit = await storage.getCacheProposalAudit(a.id);
      expect(audit).toHaveLength(1);
      expect(audit[0].proposal_id).toBe(a.id);
    });
  });

  describe('discriminated union typing', () => {
    it('preserves payload shape for semantic invalidate', async () => {
      const created = await storage.createCacheProposal({
        id: randomUUID(),
        connection_id: CONNECTION_ID,
        cache_name: 'sc:default',
        cache_type: 'semantic_cache',
        proposal_type: 'invalidate',
        proposal_payload: {
          filter_kind: 'valkey_search',
          filter_expression: '@model:{gpt-4o}',
          estimated_affected: 42,
        },
      });
      if (
        created.cache_type === 'semantic_cache' &&
        created.proposal_type === 'invalidate'
      ) {
        expect(created.proposal_payload.filter_kind).toBe('valkey_search');
        expect(created.proposal_payload.estimated_affected).toBe(42);
      } else {
        throw new Error('discriminated union narrowing failed');
      }
    });

    it('preserves payload shape for agent invalidate by tool', async () => {
      const created: StoredCacheProposal = await storage.createCacheProposal({
        id: randomUUID(),
        connection_id: CONNECTION_ID,
        cache_name: 'ac:default',
        cache_type: 'agent_cache',
        proposal_type: 'invalidate',
        proposal_payload: {
          filter_kind: 'tool',
          filter_value: 'get_weather',
          estimated_affected: 17,
        },
      });
      if (created.cache_type === 'agent_cache' && created.proposal_type === 'invalidate') {
        expect(created.proposal_payload.filter_kind).toBe('tool');
        expect(created.proposal_payload.filter_value).toBe('get_weather');
      } else {
        throw new Error('discriminated union narrowing failed');
      }
    });
  });
});
