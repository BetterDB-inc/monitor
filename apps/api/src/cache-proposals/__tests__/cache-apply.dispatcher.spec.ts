import {
  CacheApplyDispatcher,
} from '../cache-apply.dispatcher';
import { CacheResolverService, type ResolvedCache } from '../cache-resolver.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ApplyFailedError } from '../errors';
import type { StoredCacheProposal } from '@betterdb/shared';

class FakeClient {
  public hsets: Array<{ key: string; field: string; value: string }> = [];
  public deletes: string[] = [];

  async hset(key: string, field: string, value: string): Promise<number> {
    this.hsets.push({ key, field, value });
    return 1;
  }

  async del(...keys: string[]): Promise<number> {
    this.deletes.push(...keys);
    return keys.length;
  }

  public scanCalls: string[] = [];
  public scanResults: string[] = [];

  async scan(_cursor: string, _match: string, pattern: string, _count: string, _n: number): Promise<[string, string[]]> {
    this.scanCalls.push(pattern);
    return ['0', this.scanResults];
  }

  public ftSearchResponse: unknown = [0];

  async call(): Promise<unknown> {
    return this.ftSearchResponse;
  }
}

const buildDispatcher = (cache: ResolvedCache, client: FakeClient) => {
  const registry = {
    get: () => ({ getClient: () => client }),
  } as unknown as ConnectionRegistry;
  const resolver = {
    resolveCacheByName: async () => cache,
  } as unknown as CacheResolverService;
  return new CacheApplyDispatcher(registry, resolver);
};

const SEMANTIC_CACHE: ResolvedCache = {
  name: 'sc:prod',
  type: 'semantic_cache',
  prefix: 'sc:prod',
  capabilities: ['threshold_adjust'],
  protocol_version: 1,
  live: true,
};

const AGENT_CACHE: ResolvedCache = {
  name: 'ac:prod',
  type: 'agent_cache',
  prefix: 'ac:prod',
  capabilities: [],
  protocol_version: 1,
  live: true,
};

const proposal = (overrides: Partial<StoredCacheProposal>): StoredCacheProposal =>
  ({
    id: 'p1',
    connection_id: 'c1',
    cache_name: 'sc:prod',
    cache_type: 'semantic_cache',
    proposal_type: 'threshold_adjust',
    proposal_payload: { category: null, current_threshold: 0.1, new_threshold: 0.5 },
    reasoning: 'r',
    status: 'approved',
    proposed_by: 'u',
    proposed_at: 0,
    reviewed_by: null,
    reviewed_at: null,
    applied_at: null,
    applied_result: null,
    expires_at: 0,
    ...overrides,
  } as StoredCacheProposal);

describe('CacheApplyDispatcher', () => {
  it('semantic threshold_adjust writes HSET to {cache_name}:__config', async () => {
    const client = new FakeClient();
    const dispatcher = buildDispatcher(SEMANTIC_CACHE, client);
    await dispatcher.dispatch(proposal({}));
    expect(client.hsets).toEqual([
      { key: 'sc:prod:__config', field: 'threshold', value: '0.5' },
    ]);
  });

  it('semantic threshold_adjust with category writes namespaced field', async () => {
    const client = new FakeClient();
    const dispatcher = buildDispatcher(SEMANTIC_CACHE, client);
    await dispatcher.dispatch(
      proposal({
        proposal_payload: { category: 'support', current_threshold: 0.1, new_threshold: 0.7 },
      }),
    );
    expect(client.hsets[0]).toEqual({
      key: 'sc:prod:__config',
      field: 'threshold:support',
      value: '0.7',
    });
  });

  it('semantic threshold_adjust fails when capability missing', async () => {
    const client = new FakeClient();
    const dispatcher = buildDispatcher({ ...SEMANTIC_CACHE, capabilities: [] }, client);
    await expect(dispatcher.dispatch(proposal({}))).rejects.toBeInstanceOf(ApplyFailedError);
    expect(client.hsets).toEqual([]);
  });

  it('agent tool_ttl_adjust writes JSON policy to {cache_name}:__tool_policies', async () => {
    const client = new FakeClient();
    const dispatcher = buildDispatcher(AGENT_CACHE, client);
    await dispatcher.dispatch(
      proposal({
        cache_name: 'ac:prod',
        cache_type: 'agent_cache',
        proposal_type: 'tool_ttl_adjust',
        proposal_payload: {
          tool_name: 'search_index',
          current_ttl_seconds: 60,
          new_ttl_seconds: 600,
        },
      }),
    );
    expect(client.hsets).toEqual([
      {
        key: 'ac:prod:__tool_policies',
        field: 'search_index',
        value: JSON.stringify({ ttl: 600 }),
      },
    ]);
  });

  it('semantic invalidate parses FT.SEARCH RETURN 0 response without skipping keys', async () => {
    const client = new FakeClient();
    client.ftSearchResponse = [3, 'sc:prod:k1', 'sc:prod:k2', 'sc:prod:k3'];
    const dispatcher = buildDispatcher(SEMANTIC_CACHE, client);
    const out = await dispatcher.dispatch(
      proposal({
        proposal_type: 'invalidate',
        proposal_payload: {
          filter_kind: 'valkey_search',
          filter_expression: '@model:{gpt}',
          estimated_affected: 10,
        },
      }),
    );
    expect(client.deletes).toEqual(['sc:prod:k1', 'sc:prod:k2', 'sc:prod:k3']);
    expect(out.actualAffected).toBe(3);
  });

  it('agent invalidate by key_prefix scopes the SCAN pattern to the cache namespace', async () => {
    const client = new FakeClient();
    const dispatcher = buildDispatcher(AGENT_CACHE, client);
    await dispatcher.dispatch(
      proposal({
        cache_name: 'ac:prod',
        cache_type: 'agent_cache',
        proposal_type: 'invalidate',
        proposal_payload: {
          filter_kind: 'key_prefix',
          filter_value: 'memo:',
          estimated_affected: 5,
        },
      }),
    );
    expect(client.scanCalls).toEqual(['ac:prod:memo:*']);
  });

  it('fails when cache type changed since proposal creation', async () => {
    const client = new FakeClient();
    const dispatcher = buildDispatcher(AGENT_CACHE, client);
    await expect(
      dispatcher.dispatch(
        proposal({ cache_name: 'ac:prod', cache_type: 'semantic_cache' }),
      ),
    ).rejects.toBeInstanceOf(ApplyFailedError);
  });
});
