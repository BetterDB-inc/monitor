import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { AgentCache } from '../AgentCache';
import type { LlmCacheParams, LlmCacheResult } from '../types';
import { llmCacheHash } from '../utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgentCache(): AgentCache & { capturedParams: LlmCacheParams | null } {
  const mock = {
    capturedParams: null as LlmCacheParams | null,
    llm: {
      check: vi.fn(async (params: LlmCacheParams) => {
        mock.capturedParams = params;
        return { hit: true, response: 'cached', tier: 'llm' } as LlmCacheResult;
      }),
      store: vi.fn(),
    },
    tool: { check: vi.fn(), store: vi.fn() },
    session: {
      get: vi.fn(), set: vi.fn(), getAll: vi.fn(),
      scanFieldsByPrefix: vi.fn(), delete: vi.fn(),
      destroyThread: vi.fn(), touch: vi.fn(),
    },
    stats: vi.fn(),
    toolEffectiveness: vi.fn(),
    flush: vi.fn(),
  } as unknown as AgentCache & { capturedParams: LlmCacheParams | null };
  return mock;
}

const BASE_PROMPT = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];
const BASE_MESSAGES = [{ role: 'user' as const, content: 'Hello' }];

/** Call the Vercel middleware and return the LlmCacheParams it computed. */
async function vercelParams(
  middleware: { wrapGenerate?: Function },
  params: Record<string, unknown>,
  mockCache: AgentCache & { capturedParams: LlmCacheParams | null },
): Promise<LlmCacheParams> {
  mockCache.capturedParams = null;
  await middleware.wrapGenerate!({
    doGenerate: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
    }),
    params: {
      model: { modelId: 'gpt-4o', provider: 'openai' },
      prompt: BASE_PROMPT,
      ...params,
    },
  });
  return mockCache.capturedParams!;
}

// ===========================================================================
// Vercel AI SDK adapter — cache key divergence
// ===========================================================================

describe('Vercel AI SDK adapter — cache key divergence', () => {
  let createAgentCacheMiddleware: typeof import('../adapters/ai').createAgentCacheMiddleware;

  const toolA = { type: 'function', name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } };
  const toolB = { type: 'function', name: 'search', description: 'Search web', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
  const toolA_altParams = { type: 'function', name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: { location: { type: 'string' } } } };

  beforeAll(async () => {
    const m = await import('../adapters/ai');
    createAgentCacheMiddleware = m.createAgentCacheMiddleware;
  });

  // --- Case 1: Tool sensitivity ---

  it('different tool names produce different keys', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, { tools: [toolA] }, mock);
    const p2 = await vercelParams(mw, { tools: [toolB] }, mock);

    expect(llmCacheHash(p1)).not.toBe(llmCacheHash(p2));
  });

  it('same tool name but different parameter schemas produce different keys', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, { tools: [toolA] }, mock);
    const p2 = await vercelParams(mw, { tools: [toolA_altParams] }, mock);

    expect(llmCacheHash(p1)).not.toBe(llmCacheHash(p2));
  });

  // --- Case 2: Tool stability (order invariance) ---

  it('same tools in different array order produce the same key', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, { tools: [toolA, toolB] }, mock);
    const p2 = await vercelParams(mw, { tools: [toolB, toolA] }, mock);

    expect(llmCacheHash(p1)).toBe(llmCacheHash(p2));
  });

  // --- Case 3: Tools-absent baseline ---

  it('no tools and with tools produce different keys', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const pNoTools = await vercelParams(mw, {}, mock);
    const pWithTools = await vercelParams(mw, { tools: [toolA] }, mock);

    expect(llmCacheHash(pNoTools)).not.toBe(llmCacheHash(pWithTools));
  });

  it('no tools on both calls produces the same key', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, {}, mock);
    const p2 = await vercelParams(mw, {}, mock);

    expect(llmCacheHash(p1)).toBe(llmCacheHash(p2));
  });

  // --- Case 4: Param sensitivity ---

  it('changing seed changes the key', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, { seed: 42 }, mock);
    const p2 = await vercelParams(mw, { seed: 99 }, mock);

    expect(llmCacheHash(p1)).not.toBe(llmCacheHash(p2));
  });

  it('same seed produces the same key', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, { seed: 42 }, mock);
    const p2 = await vercelParams(mw, { seed: 42 }, mock);

    expect(llmCacheHash(p1)).toBe(llmCacheHash(p2));
  });

  it('changing stopSequences changes the key', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, { stopSequences: ['END'] }, mock);
    const p2 = await vercelParams(mw, { stopSequences: ['STOP'] }, mock);

    expect(llmCacheHash(p1)).not.toBe(llmCacheHash(p2));
  });

  it('changing responseFormat changes the key', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, { responseFormat: { type: 'text' } }, mock);
    const p2 = await vercelParams(mw, { responseFormat: { type: 'json' } }, mock);

    expect(llmCacheHash(p1)).not.toBe(llmCacheHash(p2));
  });

  it('changing toolChoice changes the key', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const p1 = await vercelParams(mw, { tools: [toolA], toolChoice: { type: 'auto' } }, mock);
    const p2 = await vercelParams(mw, { tools: [toolA], toolChoice: { type: 'none' } }, mock);

    expect(llmCacheHash(p1)).not.toBe(llmCacheHash(p2));
  });

  // --- Case 5: Canonical-shape parity ---

  it('Vercel flat tool shape produces same key as hand-written canonical shape', async () => {
    const mock = createMockAgentCache();
    const mw = createAgentCacheMiddleware({ cache: mock });

    const vercel = await vercelParams(mw, { tools: [toolA] }, mock);

    const handwritten: LlmCacheParams = {
      model: 'gpt-4o',
      messages: vercel.messages,
      temperature: vercel.temperature,
      top_p: vercel.top_p,
      max_tokens: vercel.max_tokens,
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }],
    };

    expect(llmCacheHash(vercel)).toBe(llmCacheHash(handwritten));
  });
});

// ===========================================================================
// LlamaIndex TS adapter — cache key divergence
// ===========================================================================

describe('LlamaIndex TS adapter — cache key divergence', () => {
  let prepareParams: typeof import('../adapters/llamaindex').prepareParams;

  const msgs = [{ role: 'user', content: 'Hello' }] as import('@llamaindex/core/llms').ChatMessage[];

  const toolA = {
    metadata: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
  };
  const toolB = {
    metadata: { name: 'search', description: 'Search web', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  };
  const toolA_altParams = {
    metadata: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { location: { type: 'string' } } } },
  };

  beforeAll(async () => {
    const m = await import('../adapters/llamaindex');
    prepareParams = m.prepareParams;
  });

  // --- Case 1: Tool sensitivity ---

  it('different tool names produce different keys', async () => {
    const p1 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolA] });
    const p2 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolB] });

    expect(llmCacheHash(p1)).not.toBe(llmCacheHash(p2));
  });

  it('same tool name but different parameter schemas produce different keys', async () => {
    const p1 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolA] });
    const p2 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolA_altParams] });

    expect(llmCacheHash(p1)).not.toBe(llmCacheHash(p2));
  });

  // --- Case 2: Tool stability (order invariance) ---

  it('same tools in different array order produce the same key', async () => {
    const p1 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolA, toolB] });
    const p2 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolB, toolA] });

    expect(llmCacheHash(p1)).toBe(llmCacheHash(p2));
  });

  // --- Case 3: Tools-absent baseline ---

  it('no tools and with tools produce different keys', async () => {
    const pNoTools = await prepareParams(msgs, { model: 'gpt-4o' });
    const pWithTools = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolA] });

    expect(llmCacheHash(pNoTools)).not.toBe(llmCacheHash(pWithTools));
  });

  it('no tools on both calls produces the same key', async () => {
    const p1 = await prepareParams(msgs, { model: 'gpt-4o' });
    const p2 = await prepareParams(msgs, { model: 'gpt-4o' });

    expect(llmCacheHash(p1)).toBe(llmCacheHash(p2));
  });

  // --- Case 6: Closure safety ---

  it('tool with a non-serializable call closure produces stable key from metadata only', async () => {
    const toolWithClosure = {
      metadata: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
      call: (input: unknown) => Promise.resolve({ temp: 20 }),
    };
    const toolPlain = {
      metadata: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
    };

    const p1 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolWithClosure] });
    const p2 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolPlain] });

    // Both produce the same key (closure is ignored)
    expect(llmCacheHash(p1)).toBe(llmCacheHash(p2));

    // Key is deterministic across repeated calls
    const p3 = await prepareParams(msgs, { model: 'gpt-4o', tools: [toolWithClosure] });
    expect(llmCacheHash(p1)).toBe(llmCacheHash(p3));
  });
});
