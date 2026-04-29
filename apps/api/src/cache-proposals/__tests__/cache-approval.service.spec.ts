import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { CacheApplyService } from '../cache-apply.service';
import { CacheProposalService } from '../cache-proposal.service';
import { CacheResolverService, type ResolvedCache } from '../cache-resolver.service';
import { CacheApplyDispatcher } from '../cache-apply.dispatcher';
import {
  ApplyFailedError,
  ProposalEditNotAllowedError,
  ProposalExpiredError,
  ProposalNotFoundError,
  ProposalNotPendingError,
} from '../errors';

const CONNECTION_ID = 'conn-test';
const SEMANTIC_CACHE_NAME = 'sc:prod';
const AGENT_CACHE_NAME = 'ac:prod';
const VALID_REASON = 'tightening based on observed false-positive rate above 6%';

class StubResolver {
  readonly entries = new Map<string, ResolvedCache>();

  set(name: string, type: ResolvedCache['type'], capabilities: string[] = []): void {
    this.entries.set(`${CONNECTION_ID}:${name}`, {
      name,
      type,
      prefix: name,
      capabilities,
      protocol_version: 1,
      live: true,
    });
  }

  async resolveCacheByName(connectionId: string, name: string): Promise<ResolvedCache | null> {
    return this.entries.get(`${connectionId}:${name}`) ?? null;
  }
}

class StubDispatcher {
  public calls: Array<{ id: string; type: string }> = [];
  public failNext = false;

  async dispatch(proposal: { id: string; cache_type: string; proposal_type: string }): Promise<{
    durationMs: number;
    actualAffected?: number;
    details: Record<string, unknown>;
  }> {
    this.calls.push({ id: proposal.id, type: `${proposal.cache_type}/${proposal.proposal_type}` });
    if (this.failNext) {
      throw new ApplyFailedError(proposal.id, 'simulated apply failure', { reason: 'test' });
    }
    return {
      durationMs: 1,
      actualAffected: proposal.proposal_type === 'invalidate' ? 7 : undefined,
      details: { simulated: true },
    };
  }
}

interface Harness {
  service: CacheProposalService;
  storage: MemoryAdapter;
  resolver: StubResolver;
  dispatcher: StubDispatcher;
}

const buildHarness = (): Harness => {
  const storage = new MemoryAdapter();
  const resolver = new StubResolver();
  resolver.set(SEMANTIC_CACHE_NAME, 'semantic_cache', ['threshold_adjust']);
  resolver.set(AGENT_CACHE_NAME, 'agent_cache');
  const dispatcher = new StubDispatcher();
  const apply = new CacheApplyService(storage, dispatcher as unknown as CacheApplyDispatcher);
  const service = new CacheProposalService(
    storage,
    resolver as unknown as CacheResolverService,
    apply,
  );
  return { service, storage, resolver, dispatcher };
};

const proposeThreshold = async (h: Harness): Promise<string> => {
  const { proposal } = await h.service.proposeThresholdAdjust(CONNECTION_ID, {
    cacheName: SEMANTIC_CACHE_NAME,
    newThreshold: 0.5,
    reasoning: VALID_REASON,
  });
  return proposal.id;
};

const proposeToolTtl = async (h: Harness): Promise<string> => {
  const { proposal } = await h.service.proposeToolTtlAdjust(CONNECTION_ID, {
    cacheName: AGENT_CACHE_NAME,
    toolName: 'search_index',
    newTtlSeconds: 600,
    reasoning: VALID_REASON,
  });
  return proposal.id;
};

const proposeInvalidate = async (h: Harness): Promise<string> => {
  const { proposal } = await h.service.proposeInvalidate(CONNECTION_ID, {
    cacheName: AGENT_CACHE_NAME,
    filterKind: 'tool',
    filterValue: 'search_index',
    estimatedAffected: 100,
    reasoning: VALID_REASON,
  });
  return proposal.id;
};

describe('CacheProposalService.approve', () => {
  it('errors with PROPOSAL_NOT_FOUND', async () => {
    const h = buildHarness();
    await expect(
      h.service.approve({ proposalId: 'nope', actor: 'user-1', actorSource: 'ui' }),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
  });

  it('errors with PROPOSAL_EXPIRED when expires_at has passed', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    const proposal = (await h.storage.getCacheProposal(id))!;
    await h.storage.updateCacheProposalStatus({
      id,
      status: 'pending',
      reviewed_at: null,
    });
    (proposal as unknown as { expires_at: number }).expires_at = Date.now() - 1;
    // Force-expire: rewrite via internal storage. Memory adapter uses structuredClone.
    (h.storage as unknown as { cacheProposals: Map<string, typeof proposal> }).cacheProposals.set(id, {
      ...proposal,
      expires_at: Date.now() - 1,
    });
    await expect(
      h.service.approve({ proposalId: id, actor: 'user-1', actorSource: 'ui' }),
    ).rejects.toBeInstanceOf(ProposalExpiredError);
  });

  it('errors with PROPOSAL_NOT_PENDING after rejection', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    await h.service.reject({ proposalId: id, actor: 'user-1', actorSource: 'ui' });
    await expect(
      h.service.approve({ proposalId: id, actor: 'user-1', actorSource: 'ui' }),
    ).rejects.toBeInstanceOf(ProposalNotPendingError);
  });

  it('is idempotent: second approve on already-applied returns current state', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    const first = await h.service.approve({ proposalId: id, actor: 'user-1', actorSource: 'ui' });
    expect(first.proposal.status).toBe('applied');
    const second = await h.service.approve({ proposalId: id, actor: 'user-1', actorSource: 'ui' });
    expect(second.proposal.status).toBe('applied');
    expect(h.dispatcher.calls.length).toBe(1);
  });

  it('records actor_source = "mcp" on audit', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    await h.service.approve({ proposalId: id, actor: 'agent-7', actorSource: 'mcp' });
    const audit = await h.storage.getCacheProposalAudit(id);
    const approvedEvent = audit.find((e) => e.event_type === 'approved');
    expect(approvedEvent?.actor_source).toBe('mcp');
    const appliedEvent = audit.find((e) => e.event_type === 'applied');
    expect(appliedEvent?.actor_source).toBe('mcp');
  });

  it('marks status failed and writes failed audit when dispatcher throws', async () => {
    const h = buildHarness();
    h.dispatcher.failNext = true;
    const id = await proposeThreshold(h);
    await expect(
      h.service.approve({ proposalId: id, actor: 'user-1', actorSource: 'ui' }),
    ).rejects.toBeInstanceOf(ApplyFailedError);
    const proposal = await h.storage.getCacheProposal(id);
    expect(proposal?.status).toBe('failed');
    expect(proposal?.applied_result?.success).toBe(false);
    const audit = await h.storage.getCacheProposalAudit(id);
    expect(audit.some((e) => e.event_type === 'failed')).toBe(true);
  });
});

describe('CacheProposalService.reject', () => {
  it('stores reason when provided', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    await h.service.reject({
      proposalId: id,
      reason: 'too aggressive',
      actor: 'user-1',
      actorSource: 'ui',
    });
    const audit = await h.storage.getCacheProposalAudit(id);
    const event = audit.find((e) => e.event_type === 'rejected');
    expect(event?.event_payload).toEqual({ reason: 'too aggressive' });
  });

  it('stores null event_payload when reason omitted', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    await h.service.reject({ proposalId: id, actor: 'user-1', actorSource: 'ui' });
    const audit = await h.storage.getCacheProposalAudit(id);
    const event = audit.find((e) => e.event_type === 'rejected');
    expect(event?.event_payload).toBeNull();
  });

  it('errors with PROPOSAL_NOT_PENDING when already approved', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    await h.service.approve({ proposalId: id, actor: 'user-1', actorSource: 'ui' });
    await expect(
      h.service.reject({ proposalId: id, actor: 'user-1', actorSource: 'ui' }),
    ).rejects.toBeInstanceOf(ProposalNotPendingError);
  });
});

describe('CacheProposalService.editAndApprove', () => {
  it('rejects edits on invalidate proposals', async () => {
    const h = buildHarness();
    const id = await proposeInvalidate(h);
    await expect(
      h.service.editAndApprove({
        proposalId: id,
        edits: { newThreshold: 0.7 },
        actor: 'user-1',
        actorSource: 'ui',
      }),
    ).rejects.toBeInstanceOf(ProposalEditNotAllowedError);
  });

  it('errors when new_threshold passed for tool_ttl_adjust', async () => {
    const h = buildHarness();
    const id = await proposeToolTtl(h);
    await expect(
      h.service.editAndApprove({
        proposalId: id,
        edits: { newThreshold: 0.5 },
        actor: 'user-1',
        actorSource: 'ui',
      }),
    ).rejects.toThrow(/new_ttl_seconds is required/);
  });

  it('updates payload + approves + applies for threshold_adjust', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    const result = await h.service.editAndApprove({
      proposalId: id,
      edits: { newThreshold: 0.9 },
      actor: 'user-1',
      actorSource: 'ui',
    });
    expect(result.proposal.status).toBe('applied');
    if (result.proposal.proposal_type === 'threshold_adjust') {
      expect(result.proposal.proposal_payload.new_threshold).toBe(0.9);
    }
    const audit = await h.storage.getCacheProposalAudit(id);
    expect(audit.some((e) => e.event_type === 'edited_and_approved')).toBe(true);
  });
});

describe('CacheProposalService.expireProposals', () => {
  it('expires past-due pending proposals and writes system audit', async () => {
    const h = buildHarness();
    const id = await proposeThreshold(h);
    const original = (await h.storage.getCacheProposal(id))!;
    (h.storage as unknown as { cacheProposals: Map<string, typeof original> }).cacheProposals.set(id, {
      ...original,
      expires_at: Date.now() - 1000,
    });
    const expired = await h.service.expireProposals(Date.now(), 'system');
    expect(expired).toBe(1);
    const reread = await h.storage.getCacheProposal(id);
    expect(reread?.status).toBe('expired');
    const audit = await h.storage.getCacheProposalAudit(id);
    const event = audit.find((e) => e.event_type === 'expired');
    expect(event?.actor_source).toBe('system');
  });
});
