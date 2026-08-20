import { describe, expect, it } from 'vitest';

describe('@betterdb/ai adapter subpaths', () => {
  it('exposes both langchain adapters', async () => {
    const m = await import('../langchain');
    expect(typeof m.BetterDBLlmCache).toBe('function');
    expect(typeof m.BetterDBSemanticCache).toBe('function');
  });

  it('exposes both langgraph adapters', async () => {
    const m = await import('../langgraph');
    expect(typeof m.BetterDBSaver).toBe('function');
    expect(typeof m.BetterDBSemanticStore).toBe('function');
  });

  it('exposes both vercel ai-sdk middlewares', async () => {
    const m = await import('../vercel');
    expect(typeof m.createAgentCacheMiddleware).toBe('function');
    expect(typeof m.createSemanticCacheMiddleware).toBe('function');
  });

  it.each(['openai', 'openai-responses', 'anthropic', 'llamaindex'])(
    'exposes both prepare functions for %s',
    async (name) => {
      const m = await import(`../${name}`);
      expect(typeof m.prepareParams).toBe('function');
      expect(typeof m.prepareSemanticParams).toBe('function');
    },
  );
});
