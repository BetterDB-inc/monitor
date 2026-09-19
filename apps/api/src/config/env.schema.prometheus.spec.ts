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

  it('rejects a slot top-N out of range or fractional', () => {
    expect(envSchema.safeParse({ METRICS_SLOT_STATS_TOP_N: '-1' }).success).toBe(false);
    expect(envSchema.safeParse({ METRICS_SLOT_STATS_TOP_N: '16385' }).success).toBe(false);
    expect(envSchema.safeParse({ METRICS_SLOT_STATS_TOP_N: '2.5' }).success).toBe(false);
  });
});
