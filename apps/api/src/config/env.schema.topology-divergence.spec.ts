import { envSchema } from './env.schema';

describe('ANOMALY_TOPOLOGY_DIVERGENCE_ENABLED', () => {
  it('defaults to true', () => {
    expect(envSchema.parse({}).ANOMALY_TOPOLOGY_DIVERGENCE_ENABLED).toBe(true);
  });

  it.each(['TRUE', '1', 'enabled'])('stays on for %s', (value) => {
    const parsed = envSchema.parse({ ANOMALY_TOPOLOGY_DIVERGENCE_ENABLED: value });
    expect(parsed.ANOMALY_TOPOLOGY_DIVERGENCE_ENABLED).toBe(true);
  });

  it.each(['false', '0', ' Off '])('turns off for %s', (value) => {
    const parsed = envSchema.parse({ ANOMALY_TOPOLOGY_DIVERGENCE_ENABLED: value });
    expect(parsed.ANOMALY_TOPOLOGY_DIVERGENCE_ENABLED).toBe(false);
  });
});
