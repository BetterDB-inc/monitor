import { envSchema } from './env.schema';

describe('Prometheus metrics endpoint env', () => {
  it('enables the endpoint by default with no token', () => {
    const parsed = envSchema.parse({});
    expect(parsed.PROMETHEUS_METRICS_ENABLED).toBe(true);
    expect(parsed.PROMETHEUS_METRICS_TOKEN).toBeUndefined();
  });

  it('disables the endpoint on an explicit false', () => {
    expect(
      envSchema.parse({ PROMETHEUS_METRICS_ENABLED: 'false' }).PROMETHEUS_METRICS_ENABLED,
    ).toBe(false);
  });

  it('disables the endpoint case-insensitively', () => {
    expect(
      envSchema.parse({ PROMETHEUS_METRICS_ENABLED: 'FALSE' }).PROMETHEUS_METRICS_ENABLED,
    ).toBe(false);
    expect(
      envSchema.parse({ PROMETHEUS_METRICS_ENABLED: 'False' }).PROMETHEUS_METRICS_ENABLED,
    ).toBe(false);
    expect(
      envSchema.parse({ PROMETHEUS_METRICS_ENABLED: ' false ' }).PROMETHEUS_METRICS_ENABLED,
    ).toBe(false);
  });

  it('normalises a whitespace-only token to unset', () => {
    const result = envSchema.safeParse({ PROMETHEUS_METRICS_TOKEN: '   ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PROMETHEUS_METRICS_TOKEN).toBeUndefined();
    }
  });

  it('requires a token in cloud mode', () => {
    const result = envSchema.safeParse({
      CLOUD_MODE: 'true',
      OTEL_INGEST_TOKEN: 'ingest',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('PROMETHEUS_METRICS_TOKEN');
  });

  it('still fails validation in cloud mode when the token is blank', () => {
    const result = envSchema.safeParse({
      CLOUD_MODE: 'true',
      OTEL_INGEST_TOKEN: 'ingest',
      PROMETHEUS_METRICS_TOKEN: '   ',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('PROMETHEUS_METRICS_TOKEN');
  });

  it('accepts cloud mode with a token', () => {
    expect(
      envSchema.safeParse({
        CLOUD_MODE: 'true',
        OTEL_INGEST_TOKEN: 'ingest',
        PROMETHEUS_METRICS_TOKEN: 'scrape',
      }).success,
    ).toBe(true);
  });

  it('accepts cloud mode with the endpoint switched off', () => {
    expect(
      envSchema.safeParse({
        CLOUD_MODE: 'true',
        OTEL_INGEST_TOKEN: 'ingest',
        PROMETHEUS_METRICS_ENABLED: 'false',
      }).success,
    ).toBe(true);
  });
});

describe('Metric export profile env', () => {
  it('defaults to the full profile and top 100 slots', () => {
    const parsed = envSchema.parse({});
    expect(parsed.METRICS_EXPORT_PROFILE).toBe('full');
    expect(parsed.METRICS_SLOT_STATS_TOP_N).toBe(100);
  });

  it('accepts vitals case- and whitespace-insensitively', () => {
    expect(envSchema.parse({ METRICS_EXPORT_PROFILE: ' Vitals ' }).METRICS_EXPORT_PROFILE).toBe(
      'vitals',
    );
  });

  it('rejects an unknown profile', () => {
    expect(envSchema.safeParse({ METRICS_EXPORT_PROFILE: 'minimal' }).success).toBe(false);
  });

  it('accepts a slot top-N in range, including zero', () => {
    expect(envSchema.parse({ METRICS_SLOT_STATS_TOP_N: '0' }).METRICS_SLOT_STATS_TOP_N).toBe(0);
    expect(envSchema.parse({ METRICS_SLOT_STATS_TOP_N: '16384' }).METRICS_SLOT_STATS_TOP_N).toBe(
      16384,
    );
  });

  it('clamps a slot top-N out of range to the bound and floors a fractional value instead of failing boot', () => {
    // The schema mirrors the runtime resolvers (export-profile.ts): an
    // out-of-range value is clamped to 0..max rather than aborting boot or
    // silently reverting to the default.
    expect(envSchema.parse({ METRICS_SLOT_STATS_TOP_N: '-1' }).METRICS_SLOT_STATS_TOP_N).toBe(0);
    expect(envSchema.parse({ METRICS_SLOT_STATS_TOP_N: '16385' }).METRICS_SLOT_STATS_TOP_N).toBe(
      16384,
    );
    expect(envSchema.parse({ METRICS_SLOT_STATS_TOP_N: '2.5' }).METRICS_SLOT_STATS_TOP_N).toBe(2);
  });

  it('clamps out-of-range key-size top-N values to their bounds instead of failing boot', () => {
    expect(envSchema.parse({ METRICS_KEY_DETAILS_TOP_N: '500' }).METRICS_KEY_DETAILS_TOP_N).toBe(
      50,
    );
    expect(
      envSchema.parse({ METRICS_KEY_PATTERNS_TOP_N: '99999' }).METRICS_KEY_PATTERNS_TOP_N,
    ).toBe(10000);
    expect(envSchema.parse({ METRICS_KEY_DETAILS_TOP_N: '25' }).METRICS_KEY_DETAILS_TOP_N).toBe(
      25,
    );
  });

  it('falls back to the default for a malformed (non-numeric) top-N instead of failing boot', () => {
    expect(envSchema.parse({ METRICS_SLOT_STATS_TOP_N: 'abc' }).METRICS_SLOT_STATS_TOP_N).toBe(100);
    expect(envSchema.parse({ METRICS_KEY_DETAILS_TOP_N: 'xyz' }).METRICS_KEY_DETAILS_TOP_N).toBe(
      10,
    );
  });

  it('treats a blank profile as unset and defaults to full', () => {
    expect(envSchema.parse({ METRICS_EXPORT_PROFILE: '' }).METRICS_EXPORT_PROFILE).toBe('full');
  });

  it('treats a whitespace-only profile as unset and defaults to full', () => {
    expect(envSchema.parse({ METRICS_EXPORT_PROFILE: '   ' }).METRICS_EXPORT_PROFILE).toBe(
      'full',
    );
  });

  it('treats a blank slot top-N as unset and defaults to 100', () => {
    expect(envSchema.parse({ METRICS_SLOT_STATS_TOP_N: '' }).METRICS_SLOT_STATS_TOP_N).toBe(100);
  });

  it('treats a whitespace-only slot top-N as unset and defaults to 100', () => {
    expect(envSchema.parse({ METRICS_SLOT_STATS_TOP_N: '   ' }).METRICS_SLOT_STATS_TOP_N).toBe(
      100,
    );
  });
});
