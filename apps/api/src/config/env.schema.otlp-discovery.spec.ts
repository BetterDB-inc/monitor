import { envSchema } from './env.schema';

describe('OTLP_DISCOVER_INSTANCES', () => {
  it('defaults to true', () => {
    expect(envSchema.parse({}).OTLP_DISCOVER_INSTANCES).toBe(true);
  });

  it.each(['TRUE', '1', 'enabled'])('stays on for %s', (value) => {
    expect(envSchema.parse({ OTLP_DISCOVER_INSTANCES: value }).OTLP_DISCOVER_INSTANCES).toBe(true);
  });

  it.each(['false', '0', ' Off '])('turns off for %s', (value) => {
    expect(envSchema.parse({ OTLP_DISCOVER_INSTANCES: value }).OTLP_DISCOVER_INSTANCES).toBe(false);
  });
});
