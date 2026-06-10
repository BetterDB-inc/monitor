import { CacheReadonlyService } from '../cache-readonly.service';
import { CacheResolverService, type ResolvedCache } from '../cache-resolver.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { MemoryAdapter } from '@app/storage/adapters/memory.adapter';
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
  async lrange(_key: string, _start: number, _stop: number): Promise<string[]> {
    return [];
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

class StubLicenseService {
  private tier: 'community' | 'pro' | 'enterprise' = 'pro';
  setTier(t: 'community' | 'pro' | 'enterprise'): void {
    this.tier = t;
  }
  getLicenseTier(): string {
    return this.tier;
  }
}

const buildService = async (): Promise<{
  service: CacheReadonlyService;
  client: StubValkey;
  resolver: StubResolver;
  storage: MemoryAdapter;
  license: StubLicenseService;
}> => {
  const client = new StubValkey();
  const resolver = new StubResolver();
  resolver.set(SEMANTIC_NAME, 'semantic_cache');
  resolver.set(AGENT_NAME, 'agent_cache');
  const storage = new MemoryAdapter();
  await storage.initialize();
  const registry = new StubRegistry(client);
  const license = new StubLicenseService();
  const service = new CacheReadonlyService(
    registry as unknown as ConnectionRegistry,
    resolver as unknown as CacheResolverService,
    storage,
    license as unknown as import('@proprietary/licenses').LicenseService,
  );
  return { service, client, resolver, storage, license };
};

const seedRegistry = (
  client: StubValkey,
  entries: Record<string, { type: CacheType; prefix: string }>,
): void => {
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

const seedSamplesWithCost = (
  client: StubValkey,
  prefix: string,
  samples: Array<{
    score: number;
    result: 'hit' | 'miss';
    category: string;
    ts?: number;
    cost?: number | null;
  }>,
): void => {
  const baseTs = Date.now();
  client.zsets[`${prefix}:__similarity_window`] = samples.map((s, i) => ({
    member: JSON.stringify({
      score: s.score,
      result: s.result,
      category: s.category,
      _n: i,
      cost_saved_micros: s.cost === undefined ? null : s.cost,
    }),
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

    it('reads stats from prefix, not name, when they differ', async () => {
      const { service, client } = await buildService();
      const ALIAS = 'prod-llm';
      const PREFIX = 'betterdb_scache_prod';
      seedRegistry(client, {
        [ALIAS]: { type: 'semantic_cache', prefix: PREFIX },
      });
      client.hashes[`${PREFIX}:__stats`] = { hits: '90', misses: '10', total: '100' };
      client.hashes[`${ALIAS}:__stats`] = { hits: '0', misses: '0', total: '0' };

      const result = await service.listCaches(CONNECTION_ID);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe(ALIAS);
      expect(result[0].prefix).toBe(PREFIX);
      expect(result[0].hit_rate).toBeCloseTo(0.9);
      expect(result[0].total_ops).toBe(100);
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
      // High hit rate (>80%) with many uncertain hits near the threshold boundary.
      // Most hits are well below the proposed new threshold so the recall-cost guard passes.
      // threshold=0.1, uncertainty_band=0.05, proposed tighten → 0.07
      const samples = [
        // 85 strong hits well below proposed threshold (0.07) — these survive tightening
        ...Array.from({ length: 85 }, (_, i) => ({
          score: 0.02 + (i % 5) * 0.01, // 0.02–0.06
          result: 'hit' as const,
          category: 'all',
          ts: Date.now() + i,
        })),
        // 10 uncertain hits near the boundary — trigger the signal
        ...Array.from({ length: 10 }, (_, i) => ({
          score: 0.08 + i * 0.001, // 0.080–0.089
          result: 'hit' as const,
          category: 'all',
          ts: Date.now() + 100 + i,
        })),
        // 5 misses above threshold
        ...Array.from({ length: 5 }, (_, i) => ({
          score: 0.2,
          result: 'miss' as const,
          category: 'all',
          ts: Date.now() + 200 + i,
        })),
      ];
      // hitRate = 95/100 = 0.95
      // uncertainHits (score >= 0.05): 85 hits include ~51 with score >= 0.05, plus 10 boundary = ~61
      //   uncertainHitRate ≈ 0.64, uncertainFractionOfAll ≈ 0.61 > 0.15 ✓
      // hitsLost (score between 0.07 and 0.1): the 10 boundary hits → recallCost = 10/95 ≈ 0.105 < 0.15 ✓
      seedSimilarityWindow(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('tighten_threshold');
      expect(result.recommended_threshold).toBeLessThan(0.1);
    });

    it('returns null confidence fields for insufficient_data', async () => {
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
      expect(result.confidence_score).toBeNull();
      expect(result.confidence_breakdown).toBeNull();
    });

    it('populates confidence_score and breakdown on tighten_threshold', async () => {
      const { service, client } = await buildService();
      const now = Date.now();
      const samples = [
        ...Array.from({ length: 85 }, (_, i) => ({
          score: 0.02 + (i % 5) * 0.01,
          result: 'hit' as const,
          category: 'all',
          ts: now + i,
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          score: 0.08 + i * 0.001,
          result: 'hit' as const,
          category: 'all',
          ts: now + 100 + i,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          score: 0.2,
          result: 'miss' as const,
          category: 'all',
          ts: now + 200 + i,
        })),
      ];
      seedSimilarityWindow(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('tighten_threshold');
      expect(result.confidence_score).not.toBeNull();
      expect(result.confidence_score).toBeGreaterThan(0);
      expect(result.confidence_score).toBeLessThanOrEqual(1);
      expect(result.confidence_breakdown).not.toBeNull();
      const breakdown = result.confidence_breakdown!;
      expect(breakdown.sample).toBeGreaterThan(0);
      expect(breakdown.signal).toBeGreaterThan(0);
      expect(breakdown.freshness).toBeGreaterThan(0);
    });

    it('drives confidence to 0 when samples are stale', async () => {
      const { service, client } = await buildService();
      const twoHoursAgo = Date.now() - 2 * 3_600_000;
      const samples = [
        ...Array.from({ length: 85 }, (_, i) => ({
          score: 0.02 + (i % 5) * 0.01,
          result: 'hit' as const,
          category: 'all',
          ts: twoHoursAgo + i,
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          score: 0.08 + i * 0.001,
          result: 'hit' as const,
          category: 'all',
          ts: twoHoursAgo + 100 + i,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          score: 0.2,
          result: 'miss' as const,
          category: 'all',
          ts: twoHoursAgo + 100 + i,
        })),
      ];
      seedSimilarityWindow(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('tighten_threshold');
      expect(result.confidence_score).toBe(0);
      expect(result.confidence_breakdown!.freshness).toBe(0);
    });

    it('populates non-zero confidence on low_hit_rate LOOSEN even when nearMissRate is low', async () => {
      const { service, client } = await buildService();
      const now = Date.now();
      // Defaults: threshold=0.10, uncertainty_band=0.05.
      //   near-misses:  (0.10, 0.15]
      //   close-misses: (0.10, 0.20]
      // We want CLOSE but NOT near, so misses at score 0.18.
      const samples = [
        ...Array.from({ length: 3 }, (_, i) => ({
          score: 0.03,
          result: 'hit' as const,
          category: 'all',
          ts: now + i,
        })),
        ...Array.from({ length: 100 }, (_, i) => ({
          score: 0.18,
          result: 'miss' as const,
          category: 'all',
          ts: now + 10 + i,
        })),
        ...Array.from({ length: 97 }, (_, i) => ({
          score: 0.5,
          result: 'miss' as const,
          category: 'all',
          ts: now + 200 + i,
        })),
      ];
      seedSimilarityWindow(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('loosen_threshold');
      expect(result.signal).toBe('low_hit_rate');
      expect(result.confidence_score).toBeGreaterThan(0);
      expect(result.confidence_breakdown!.signal).toBeGreaterThan(0);
    });

    it('Enterprise: single expensive uncertain hit drives TIGHTEN where count-based misses it', async () => {
      const { service, client, license } = await buildService();
      license.setTier('enterprise');
      const samples: Array<{
        score: number;
        result: 'hit' | 'miss';
        category: string;
        cost: number | null;
      }> = [];
      for (let i = 0; i < 99; i++) {
        samples.push({ score: 0.02, result: 'hit', category: 'all', cost: 1000 });
      }
      samples.push({ score: 0.08, result: 'hit', category: 'all', cost: 50_000_000 });
      for (let i = 0; i < 50; i++) {
        samples.push({ score: 0.5, result: 'miss', category: 'all', cost: null });
      }
      seedSamplesWithCost(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('tighten_threshold');
      expect(result.signal).toBe('uncertain_hits');
      expect(result.cost_weighted_uncertain_hit_rate).toBeGreaterThan(0.2);
      expect(result.uncertain_hit_cost_usd).toBeCloseTo(50, 1);
    });

    it('Enterprise with no costed samples falls back to unweighted', async () => {
      const { service, client, license } = await buildService();
      license.setTier('enterprise');
      // threshold=0.10, band=0.05: uncertain = score >= 0.05
      // proposed tighten step = 0.03 → new threshold = 0.07
      // hits at 0.05 are uncertain (0.05 >= 0.05) but survive tightening (0.05 <= 0.07)
      // hits at 0.06 are uncertain and are lost (0.06 > 0.07 is false) — also survive
      // uncertainHitRate = 1.0, uncertainFractionOfAll = 1.0 * (85/90) > 0.15
      const samples = [
        ...Array.from({ length: 85 }, (_, i) => ({
          score: 0.05 + (i % 2) * 0.005,
          result: 'hit' as const,
          category: 'all',
          cost: null as number | null,
          ts: Date.now() + i,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          score: 0.2,
          result: 'miss' as const,
          category: 'all',
          cost: null as number | null,
          ts: Date.now() + 100 + i,
        })),
      ];
      seedSamplesWithCost(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('tighten_threshold');
      expect(result.cost_weighted_uncertain_hit_rate).toBeUndefined();
      expect(result.total_hit_cost_usd).toBeUndefined();
    });

    it('Pro+ with costed samples still uses count-based decision', async () => {
      const { service, client, license } = await buildService();
      license.setTier('pro');
      const samples: Array<{
        score: number;
        result: 'hit' | 'miss';
        category: string;
        cost: number | null;
        ts: number;
      }> = [];
      for (let i = 0; i < 99; i++) {
        samples.push({
          score: 0.02,
          result: 'hit',
          category: 'all',
          cost: 1000,
          ts: Date.now() + i,
        });
      }
      samples.push({
        score: 0.08,
        result: 'hit',
        category: 'all',
        cost: 50_000_000,
        ts: Date.now() + 100,
      });
      for (let i = 0; i < 50; i++) {
        samples.push({
          score: 0.5,
          result: 'miss',
          category: 'all',
          cost: null,
          ts: Date.now() + 200 + i,
        });
      }
      seedSamplesWithCost(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('optimal');
      expect(result.cost_weighted_uncertain_hit_rate).toBeUndefined();
    });

    it('populates non-zero confidence on distant_hits TIGHTEN', async () => {
      const { service, client } = await buildService();
      // Tighten the uncertainty_band so distant != uncertain (the engine's
      // distant_hits branch is unreachable with the default band=0.05).
      // threshold=0.10, band=0.01:
      //   midpoint=0.05 → distant: score > 0.05
      //   uncertain:    score >= 0.09  (threshold - band)
      client.hashes[`${SEMANTIC_NAME}:__config`] = {
        threshold: '0.10',
        uncertainty_band: '0.01',
        category_thresholds: '{}',
      };
      const now = Date.now();
      // Need hitRate > 0.8, distantHitRate > 0.25, hits.length >= 20,
      // uncertainFractionOfAll ≤ 0.15 so the uncertain_hits branch skips.
      const samples = [
        // 70 strong hits (score 0.02 — neither uncertain nor distant).
        ...Array.from({ length: 70 }, (_, i) => ({
          score: 0.02,
          result: 'hit' as const,
          category: 'all',
          ts: now + i,
        })),
        // 30 distant-but-not-uncertain hits (score 0.07 — distant, not uncertain).
        ...Array.from({ length: 30 }, (_, i) => ({
          score: 0.07,
          result: 'hit' as const,
          category: 'all',
          ts: now + 100 + i,
        })),
        // 10 misses → hitRate = 100/110 ≈ 0.91 (> 0.8). nearMissRate = 0.
        ...Array.from({ length: 10 }, (_, i) => ({
          score: 0.5,
          result: 'miss' as const,
          category: 'all',
          ts: now + 200 + i,
        })),
      ];
      seedSimilarityWindow(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('tighten_threshold');
      expect(result.signal).toBe('distant_hits');
      expect(result.confidence_score).toBeGreaterThan(0);
      expect(result.confidence_breakdown!.signal).toBeGreaterThan(0);
    });

    it('Enterprise: reasoning includes dollars when cost-weighting fired', async () => {
      const { service, client, license } = await buildService();
      license.setTier('enterprise');
      const samples: Array<{
        score: number;
        result: 'hit' | 'miss';
        category: string;
        cost: number | null;
      }> = [];
      for (let i = 0; i < 99; i++) {
        samples.push({ score: 0.02, result: 'hit', category: 'all', cost: 1000 });
      }
      samples.push({ score: 0.08, result: 'hit', category: 'all', cost: 50_000_000 });
      for (let i = 0; i < 50; i++) {
        samples.push({ score: 0.5, result: 'miss', category: 'all', cost: null });
      }
      seedSamplesWithCost(client, SEMANTIC_NAME, samples);
      const result = await service.thresholdRecommendation(CONNECTION_ID, SEMANTIC_NAME, {
        minSamples: 50,
      });
      expect(result.recommendation).toBe('tighten_threshold');
      expect(result.reasoning).toMatch(/\$50\.00/);
      expect(result.reasoning).toMatch(/saved cost/);
    });
  });

  describe('toolEffectiveness', () => {
    it('errors INVALID_CACHE_TYPE on semantic_cache', async () => {
      const { service } = await buildService();
      await expect(service.toolEffectiveness(CONNECTION_ID, SEMANTIC_NAME)).rejects.toBeInstanceOf(
        InvalidCacheTypeError,
      );
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
