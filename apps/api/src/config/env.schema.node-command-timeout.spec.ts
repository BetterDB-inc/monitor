import { envSchema } from './env.schema';

const LARGEST_TIMER_MS = 2_147_483_647;

describe('CLUSTER_NODE_COMMAND_TIMEOUT_MS', () => {
  it('defaults to 5 seconds', () => {
    expect(envSchema.parse({}).CLUSTER_NODE_COMMAND_TIMEOUT_MS).toBe(5000);
  });

  it('accepts the largest delay a timer can hold', () => {
    const parsed = envSchema.parse({ CLUSTER_NODE_COMMAND_TIMEOUT_MS: String(LARGEST_TIMER_MS) });
    expect(parsed.CLUSTER_NODE_COMMAND_TIMEOUT_MS).toBe(LARGEST_TIMER_MS);
  });

  it('rejects a value a timer would cut down to 1 ms', () => {
    const result = envSchema.safeParse({
      CLUSTER_NODE_COMMAND_TIMEOUT_MS: String(LARGEST_TIMER_MS + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a value below 100', () => {
    expect(envSchema.safeParse({ CLUSTER_NODE_COMMAND_TIMEOUT_MS: '99' }).success).toBe(false);
  });
});
