import { envSchema } from './env.schema';

describe('OTLP_DISCOVER_INSTANCES', () => {
  it('defaults to true', () => {
    expect(envSchema.parse({}).OTLP_DISCOVER_INSTANCES).toBe(true);
  });

  it('reads false', () => {
    expect(envSchema.parse({ OTLP_DISCOVER_INSTANCES: 'false' }).OTLP_DISCOVER_INSTANCES).toBe(false);
  });
});
