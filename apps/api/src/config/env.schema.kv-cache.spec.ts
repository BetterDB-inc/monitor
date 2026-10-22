import { envSchema } from './env.schema';

const KV_CACHE_FOOTPRINT_VARS = [
  'KV_CACHE_FOOTPRINT_INTERVAL_MS',
  'KV_CACHE_SCAN_MAX_KEYS',
  'KV_CACHE_MATCH_MAX_KEYS',
  'KV_CACHE_SAMPLE_KEYS',
  'KV_CACHE_UNDETECTED_RECHECK_MS',
] as const;

describe('KV cache footprint env vars', () => {
  it.each(KV_CACHE_FOOTPRINT_VARS)('registers %s', (name) => {
    expect((envSchema.parse({ [name]: '600000' }) as Record<string, unknown>)[name]).toBe('600000');
  });

  it.each(KV_CACHE_FOOTPRINT_VARS)('leaves an invalid %s to the service fallback instead of failing startup', (name) => {
    expect(envSchema.safeParse({ [name]: 'abc' }).success).toBe(true);
  });
});
