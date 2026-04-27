import { CacheReadonlyService } from '../cache-readonly.service';
import { CacheResolverService, type ResolvedCache } from '../cache-resolver.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { CacheNotFoundError, InvalidCacheTypeError } from '../errors';
import { randomUUID } from 'crypto';
import type { CacheType, CreateCacheProposalInput } from '@betterdb/shared';
import { REGISTRY_KEY, heartbeatKeyFor } from '@betterdb/shared';

const CONNECTION_ID = 'conn-test';
const SEMANTIC_NAME = 'sc:prod';
const AGENT_NAME = 'ac:prod';

class StubValkey {
  hashes: Record<string, Record<string, string>> = {};
  strings: Record<string, string> = {};
  zsets: Record<string, Array<{ member: string; score: number }>> = {};

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.hashes[key] ?? {};
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes[key]?.[field] ?? null;
  }
  async get(key: string): Promise<string | null> {
    return this.strings[key] ?? null;
  }
  async zrange(key: string, _start: string, _stop: string, mode: string): Promise<string[]> {
    const entries = this.zsets[key] ?? [];
    if (mode === 'WITHSCORES') {
      const out: string[] = [];
      for (const e of entries) {
        out.push(e.member, String(e.score));
      }
      return out;
    }
    return entries.map((e) => e.member);
  }
}

class StubResolver {
  caches = new Map<string, ResolvedCache>();
  set(name: string, type: CacheType, prefix: string = name): void {
    this.caches.set(`${CONNECTION_ID}:${name}`, {
      name,
      type,
      prefix,
      capabilities: [],
      protocol_version: 1,
      live: true,
    });
  }
  async resolveCacheByName(connectionId: string, name: string): Promise<ResolvedCache | null> {
    return this.caches.get(`${connectionId}:${name}`) ?? null;
  }
}

class StubRegistry {
  constructor(private readonly client: StubValkey) {}
  get(_id: string): { getClient(): StubValkey } {
    return { getClient: () => this.client };
  }
}

const buildService = async (): Promise<{
  service: CacheReadonlyService;
  client: StubValkey;
  resolver: StubResolver;
  storage: MemoryAdapter;
}> => {
  const client = new StubValkey();
  const resolver = new StubResolver();
  resolver.set(SEMANTIC_NAME, 'semantic_cache');
  resolver.set(AGENT_NAME, 'agent_cache');
  const storage = new MemoryAdapter();
  await storage.initialize();
  const registry = new StubRegistry(client);
  const service = new CacheReadonlyService(
    registry as unknown as ConnectionRegistry,
    resolver as unknown as CacheResolverService,
    storage,
  );
  return { service, client, resolver, storage };
};

const seedRegistry = (client: StubValkey, entries: Record<string, { type: CacheType; prefix: string }>): void => {
  client.hashes[REGISTRY_KEY] = {};
  for (const [name, marker] of Object.entries(entries)) {
    client.hashes[REGISTRY_KEY][name] = JSON.stringify({
      type: marker.type,
      prefix: marker.prefix,
      capabilities: ['threshold_adjust'],
      protocol_version: 1,
    });
  }
};

const seedSimilarityWindow = (
  client: StubValkey,
  prefix: string,
  samples: Array<{ score: number; result: 'hit' | 'miss'; category: string; ts?: number }>,
): void => {
  const baseTs = Date.now();
  client.zsets[`${prefix}:__similarity_window`] = samples.map((s, i) => ({
    member: JSON.stringify({ score: s.score, result: s.result, category: s.category, _n: i }),
    score: s.ts ?? baseTs + i,
  }));
};

describe('CacheReadonlyService', () => {
  describe('listCaches', () => {
    it('returns both cache types with the right discriminator and live/stale status', async () => {
      const { service, client } = await buildService();
      seedRegistry(client, {
        [SEMANTIC_NAME]: { type: 'semantic_cache', prefix: SEMANTIC_NAME },
        [AGENT_NAME]: { type: 'agent_cache', prefix: AGENT_NAME },
      });
      client.hashes[`${SEMANTIC_NAME}:__stats`] = { hits: '40', misses: '60', total: '100' };
      client.hashes[`${AGENT_NAME}:__stats`] = { 'tool:hits': '7', 'tool:misses': '3' };
      client.strings[heartbeatKeyFor(SEMANTIC_NAME)] = '1';

      const result = await service.listCaches(CONNECTION_ID);
      expect(result).toHaveLength(2);
      const sc = result.find((r) => r.name === SEMANTIC_NAME)!;
      const ac = result.find((r) => r.name === AGENT_NAME)!;
      expect(sc.type).toBe('semantic_cache');
      expect(sc.hit_rate).toBeCloseTo(0.4);
      expect(sc.total_ops).toBe(100);
      expect(sc.status).toBe('live');
      expect(ac.type).toBe('agent_cache');
      expect(ac.total_ops).toBe(10);
      expect(ac.status).toBe('stale');
    });

    it('returns empty when registry is empty', async () => {
      const { service } = await buildService();
      const result = await service.listCaches(CONNECTION_ID);
      expect(result).toEqual([]);
    });
  });

  describe('cacheHealth', () => {
    it('returns semantic_cache shape for a semantic cache', async () => {
      const { service, client } = await buildService();
      client.hashes[`${SEMANTIC_NAME}:__stats`] = {
        hits: '120',
        misses: '80',
        total: '200',
        cost_saved_micros: '1500000',
      };
      seedSimilarityWindow(client, SEMANTIC_NAME, [
        { score: 0.05, result: 'hit', category: 'faq' },
        { score: 0.06, result: 'hit', category: 'faq' },
        { score: 0.15, result: 'miss', category: 'support' },
      ]);

      const health = await service.cacheHealth(CONNECTION_ID, SEMANTIC_NAME);
      expect(health.type).toBe('semantic_cache');
      if (health.type === 'semantic_cache') {
        expect(health.hit_rate).toBeCloseTo(0.6);
        expect(health.miss_rate).toBeCloseTo(0.4);
        expect(health.cost_saved_total_usd).toBeCloseTo(1.5);
        expect(health.category_breakdown.length).toBeGreaterThanOrEqual(1);
      } else {
        throw new Error('discriminator narrowing failed');
      }
    });

    it('returns agent_cache shape with per-tool breakdown', async () => {
      const { service, client } = await buildService();
      client.hashes[`${AGENT_NAME}:__stats`] = {
        'tool:hits': '50',
        'tool:misses': '50',
        cost_saved_micros: '2500000',
        'tool:search:hits': '30',
        'tool:search:misses': '10',
        'tool:search:cost_saved_micros': '2000000',
        'tool:other:hits': '20',
        'tool:other:misses': '40',
        'tool:other:cost_saved_micros': '500000',
      };
      const health = await service.cacheHealth(CONNECTION_ID, AGENT_NAME);
      expect(health.type).toBe('agent_cache');
      if (health.type === 'agent_cache') {
        expect(health.hit_rate).toBeCloseTo(0.5);
        expect(health.tool_breakdown.length).toBe(2);
        expect(health.tool_breakdown[0].tool).toBe('search');
        expect(health.tool_breakdown[0].cost_saved_usd).toBeCloseTo(2);
      } else {
        throw new Error('discriminator narrowing failed');
      }
    });

    it('throws CacheNotFoundError when the cache is not in the registry', async () => {
      const { service } = await buildService();
      await expect(service.cacheHealth(CONNECTION_ID, 'unknown')).rejects.toBeInstanceOf(
        CacheNotFoundError,
      );
    });
  });

  describe('thresholdRecommendation', () => {
    it('errors INVALID_CACHE_TYPE when called on agent_cache', async () => {
      const { service } = await buildService();
      await expect(
        service.thresholdRecommendation(CONNECTION_ID, AGENT_NAME),
      ).rejects.toBeInstanceOf(InvalidCacheTypeError);
    });

    it('returns insufficient_data with low samples', async () => {
      const { service, client } = await buildService();
      seedSimilarityWindow(
        client,
        SEMANTIC_NAME,
        Array.from({ length: 5 }, (_, i) => ({
          score: 0.05,
          result: 'hit' as const,
          category: 'all',
          ts: Date.now() + i,
        })),
      );
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 10,
      });
      expect(result.recommendation).toBe('insufficient_data');
      expect(result.sample_count).toBe(5);
    });

    it('recommends tighten_threshold when uncertain hit rate is high', async () => {
      const { service, client } = await buildService();
      const samples = [
        ...Array.from({ length: 50 }, (_, i) => ({
          score: 0.09,
          result: 'hit' as const,
          category: 'all',
          ts: Date.now() + i,
        })),
        ...Array.from({ length: 50 }, (_, i) => ({
          score: 0.2,
          result: 'miss' as const,
          category: 'all',
          ts: Date.now() + 100 + i,
        })),
      ];
      seedSimilarityWindow(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('tighten_threshold');
      expect(result.recommended_threshold).toBeLessThan(0.1);
    });
  });

  describe('toolEffectiveness', () => {
    it('errors INVALID_CACHE_TYPE on semantic_cache', async () => {
      const { service } = await buildService();
      await expect(
        service.toolEffectiveness(CONNECTION_ID, SEMANTIC_NAME),
      ).rejects.toBeInstanceOf(InvalidCacheTypeError);
    });

    it('returns per-tool entries sorted by cost_saved_usd desc', async () => {
      const { service, client } = await buildService();
      client.hashes[`${AGENT_NAME}:__stats`] = {
        'tool:a:hits': '90',
        'tool:a:misses': '10',
        'tool:a:cost_saved_micros': '500000',
        'tool:b:hits': '40',
        'tool:b:misses': '60',
        'tool:b:cost_saved_micros': '4000000',
      };
      const entries = await service.toolEffectiveness(CONNECTION_ID, AGENT_NAME);
      expect(entries).toHaveLength(2);
      expect(entries[0].tool).toBe('b');
      expect(entries[0].cost_saved_usd).toBeCloseTo(4);
      expect(entries[1].tool).toBe('a');
      expect(entries[1].recommendation).toBe('optimal');
    });
  });

  describe('similarityDistribution', () => {
    it('errors INVALID_CACHE_TYPE on agent_cache', async () => {
      const { service } = await buildService();
      await expect(
        service.similarityDistribution(CONNECTION_ID, AGENT_NAME),
      ).rejects.toBeInstanceOf(InvalidCacheTypeError);
    });

    it('emits exactly 20 buckets of width 0.1 with non-negative counts', async () => {
      const { service, client } = await buildService();
      seedSimilarityWindow(client, SEMANTIC_NAME, [
        { score: 0.05, result: 'hit', category: 'all' },
        { score: 0.45, result: 'miss', category: 'all' },
        { score: 1.95, result: 'miss', category: 'all' },
      ]);
      const result = await service.similarityDistribution(CONNECTION_ID, SEMANTIC_NAME);
      expect(result.bucket_width).toBe(0.1);
      expect(result.buckets).toHaveLength(20);
      expect(result.total_samples).toBe(3);
      expect(result.buckets[0].hit_count).toBe(1);
      expect(result.buckets[4].miss_count).toBe(1);
      expect(result.buckets[19].miss_count).toBe(1);
      for (const b of result.buckets) {
        expect(b.hit_count).toBeGreaterThanOrEqual(0);
        expect(b.miss_count).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(b.hit_count)).toBe(true);
        expect(Number.isInteger(b.miss_count)).toBe(true);
      }
    });

    it('respects window_hours filter', async () => {
      const { service, client } = await buildService();
      const now = Date.now();
      seedSimilarityWindow(client, SEMANTIC_NAME, [
        { score: 0.1, result: 'hit', category: 'all', ts: now - 10 * 60 * 1000 },
        { score: 0.1, result: 'hit', category: 'all', ts: now - 48 * 60 * 60 * 1000 },
      ]);
      const result = await service.similarityDistribution(CONNECTION_ID, SEMANTIC_NAME, {
        windowHours: 24,
      });
      expect(result.total_samples).toBe(1);
    });
  });

  describe('recentChanges', () => {
    it('returns proposals filtered to the cache, newest first, respecting limit', async () => {
      const { service, storage } = await buildService();
      const baseInput = (i: number, ts: number): CreateCacheProposalInput => ({
        id: randomUUID(),
        connection_id: CONNECTION_ID,
        cache_name: SEMANTIC_NAME,
        cache_type: 'semantic_cache',
        proposal_type: 'threshold_adjust',
        proposal_payload: {
          category: `cat-${i}`,
          current_threshold: 0.1,
          new_threshold: 0.08,
        },
        proposed_at: ts,
      });
      const a = await storage.createCacheProposal(baseInput(1, 1000));
      const b = await storage.createCacheProposal(baseInput(2, 2000));
      const c = await storage.createCacheProposal(baseInput(3, 3000));
      await storage.createCacheProposal({
        ...baseInput(4, 4000),
        cache_name: 'other_cache',
      });

      const result = await service.recentChanges(CONNECTION_ID, SEMANTIC_NAME, 2);
      expect(result.map((p) => p.id)).toEqual([c.id, b.id]);
      const _ignore = a;
    });
  });
});
