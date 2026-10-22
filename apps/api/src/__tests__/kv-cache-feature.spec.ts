import { Feature, TIER_FEATURES, Tier, DEFAULT_KV_CACHE_HIT_RATE_THRESHOLD } from '@betterdb/shared';

describe('kv cache feature', () => {
  it('is a Pro feature', () => {
    expect(Feature.KV_CACHE_MONITORING).toBe('kvCacheMonitoring');
    expect(TIER_FEATURES[Tier.pro]).toContain(Feature.KV_CACHE_MONITORING);
    expect(TIER_FEATURES[Tier.community]).not.toContain(Feature.KV_CACHE_MONITORING);
  });

  it('defaults the hit rate threshold to 0.2', () => {
    expect(DEFAULT_KV_CACHE_HIT_RATE_THRESHOLD).toBe(0.2);
  });
});
