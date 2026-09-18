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

  it('requires a token in cloud mode', () => {
    const result = envSchema.safeParse({
      CLOUD_MODE: 'true',
      OTEL_INGEST_TOKEN: 'ingest',
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
