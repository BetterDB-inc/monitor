import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { AgentCache } from '../../AgentCache';
import type { LlmCacheParams, LlmCacheResult, Valkey } from '../../types';
import { LlmCache } from '../../tiers/LlmCache';
import type { Telemetry } from '../../telemetry';
import { llmCacheHash } from '../../utils';

interface FakeCallOptions extends BaseChatModelCallOptions {
  tools?: unknown[];
}

function createMockAgentCache(): AgentCache {
  return {
    llm: {
      check: vi.fn(),
      store: vi.fn(),
      storeMultipart: vi.fn(),
    },
    tool: {
      check: vi.fn(),
      store: vi.fn(),
    },
    session: {
      get: vi.fn(),
      set: vi.fn(),
      getAll: vi.fn(),
      scanFieldsByPrefix: vi.fn(),
      delete: vi.fn(),
      destroyThread: vi.fn(),
      touch: vi.fn(),
    },
    stats: vi.fn(),
    toolEffectiveness: vi.fn(),
    flush: vi.fn(),
  } as unknown as AgentCache;
}

const weatherTool = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

const searchTool = {
  type: 'function' as const,
  function: {
    name: 'search',
    description: 'Search the web',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
};

/** LangChain DynamicStructuredTool / tool() shape — not OpenAI wire format. */
const langChainStyleTool = {
  name: 'get_weather',
  description: 'Get weather for a city',
  schema: { type: 'object', properties: { city: { type: 'string' } } },
};

function toProviderWireFormat(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (typeof tool !== 'object' || tool === null) return tool;
    const t = tool as Record<string, unknown>;
    if (t.type === 'function') return tool;
    if (typeof t.name === 'string') {
      return {
        type: 'function',
        function: {
          name: t.name,
          ...(t.description != null ? { description: t.description } : {}),
          ...(t.schema != null ? { parameters: t.schema } : {}),
          ...(t.parameters != null ? { parameters: t.parameters } : {}),
        },
      };
    }
    return tool;
  });
}

class FakeChatModel extends BaseChatModel<FakeCallOptions> {
  callCount = 0;
  streamCount = 0;
  toolsAtGenerate?: unknown[];
  response: AIMessage = new AIMessage('cached-response');
  streamChunks: string[] = ['cached', '-', 'response'];

  _llmType(): string {
    return 'fake';
  }

  invocationParams(): Record<string, unknown> {
    return { model: 'fake', temperature: 0.7, max_tokens: 256 };
  }

  bindTools(
    tools: unknown[],
    kwargs?: Partial<FakeCallOptions>,
  ): ReturnType<NonNullable<BaseChatModel['bindTools']>> {
    return this.withConfig({ tools: toProviderWireFormat(tools), ...kwargs } as Partial<FakeCallOptions>);
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.callCount += 1;
    this.toolsAtGenerate = options.tools;
    const message = this.response;
    return {
      generations: [{ text: typeof message.content === 'string' ? message.content : '', message }],
    };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.streamCount += 1;
    for (const t of this.streamChunks) {
      yield new ChatGenerationChunk({ text: t, message: new AIMessageChunk({ content: t }) });
    }
  }
}

describe('CachedChatModel', () => {
  let CachedChatModel: typeof import('../langchain').CachedChatModel;

  beforeEach(async () => {
    const module = await import('../langchain');
    CachedChatModel = module.CachedChatModel;
  });

  it('caches identical prompt+tools (hit skips inner model)', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const bound = model.bindTools([weatherTool]);
    const messages = [new HumanMessage('Weather in Sofia?')];

    (mockCache.llm.check as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ hit: false, tier: 'llm' } as LlmCacheResult)
      .mockResolvedValueOnce({
        hit: true,
        response: 'cached-response',
        tier: 'llm',
      } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await bound.invoke(messages);
    await bound.invoke(messages);

    expect(inner.callCount).toBe(1);
    expect(mockCache.llm.store).toHaveBeenCalledTimes(1);
  });

  it('cache miss passes provider-formatted tools to inner model, not raw schema', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const messages = [new HumanMessage('Weather in Sofia?')];

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await model.bindTools([langChainStyleTool]).invoke(messages);

    expect(inner.toolsAtGenerate).toEqual(toProviderWireFormat([langChainStyleTool]));
    expect(inner.toolsAtGenerate?.[0]).not.toHaveProperty('schema');
  });

  it('different tools → different key → miss', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const messages = [new HumanMessage('Help me')];

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await model.bindTools([weatherTool]).invoke(messages);
    await model.bindTools([searchTool]).invoke(messages);

    expect(inner.callCount).toBe(2);
    const firstCheck = (mockCache.llm.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const secondCheck = (mockCache.llm.check as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(firstCheck.tools?.[0].function.name).toBe('get_weather');
    expect(secondCheck.tools?.[0].function.name).toBe('search');
  });

  it('no tools behaves like text cache', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const messages = [new HumanMessage('Hello')];

    (mockCache.llm.check as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ hit: false, tier: 'llm' } as LlmCacheResult)
      .mockResolvedValueOnce({
        hit: true,
        response: 'cached-response',
        tier: 'llm',
      } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await model.invoke(messages);
    await model.invoke(messages);

    expect(inner.callCount).toBe(1);
    const checkParams = (mockCache.llm.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(checkParams.tools).toBeUndefined();
  });

  it('tool-call response is stored via storeMultipart and rebuilt on hit', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    inner.response = new AIMessage({
      content: 'Let me check.',
      tool_calls: [{ id: 'call_1', name: 'get_weather', args: { city: 'Sofia' } }],
    });
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const bound = model.bindTools([weatherTool]);
    const messages = [new HumanMessage('Weather?')];

    (mockCache.llm.check as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ hit: false, tier: 'llm' } as LlmCacheResult)
      .mockResolvedValueOnce({
        hit: true,
        response: 'Let me check.',
        contentBlocks: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_call', id: 'call_1', name: 'get_weather', args: { city: 'Sofia' } },
        ],
        tier: 'llm',
      } as LlmCacheResult);
    (mockCache.llm.storeMultipart as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await bound.invoke(messages);
    const hit = await bound.invoke(messages);

    expect(mockCache.llm.storeMultipart).toHaveBeenCalledTimes(1);
    expect(mockCache.llm.store).not.toHaveBeenCalled();
    expect(inner.callCount).toBe(1);
    expect((hit as AIMessage).tool_calls).toEqual([
      { id: 'call_1', name: 'get_weather', args: { city: 'Sofia' }, type: 'tool_call' },
    ]);
  });

  it('tokens extracted from usage_metadata', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    inner.response = new AIMessage({
      content: 'Hi',
      usage_metadata: { input_tokens: 12, output_tokens: 4 },
    });
    const model = new CachedChatModel({ model: inner, cache: mockCache });

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await model.invoke([new HumanMessage('Hi')]);

    expect(mockCache.llm.store).toHaveBeenCalledWith(
      expect.any(Object),
      'Hi',
      expect.objectContaining({ tokens: { input: 12, output: 4 } }),
    );
  });

  it('zod tool-schema drift → different cache key (same name, changed parameters)', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const messages = [new HumanMessage('Weather?')];

    const v1 = tool(async () => 'x', {
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ city: z.string() }),
    });
    const v2 = tool(async () => 'x', {
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ city: z.string(), units: z.enum(['c', 'f']) }),
    });

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await model.bindTools([v1]).invoke(messages);
    await model.bindTools([v2]).invoke(messages);

    const calls = (mockCache.llm.check as ReturnType<typeof vi.fn>).mock.calls;
    const p1 = calls[0][0].tools[0].function.parameters;
    const p2 = calls[1][0].tools[0].function.parameters;

    // Must be real JSON Schema, not raw zod internals.
    expect(JSON.stringify(p1)).not.toContain('_def');
    expect(JSON.stringify(p1)).not.toContain('ZodObject');
    expect(p1).toHaveProperty('properties.city');
    expect(p2).toHaveProperty('properties.units');

    // The whole point: drift must change the key.
    expect(JSON.stringify(p1)).not.toBe(JSON.stringify(p2));
    expect(inner.callCount).toBe(2);
  });

  it('tool_choice participates in the cache key', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const messages = [new HumanMessage('Weather?')];

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await model.bindTools([weatherTool], { tool_choice: 'get_weather' }).invoke(messages);
    await model.bindTools([weatherTool], { tool_choice: 'auto' }).invoke(messages);

    const calls = (mockCache.llm.check as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].toolChoice).toBe('get_weather');
    expect(calls[1][0].toolChoice).toBe('auto');
    expect(inner.callCount).toBe(2);
  });

  it('keys on the wrapped model sampling params (temperature, max_tokens)', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    await model.invoke([new HumanMessage('Hi')]);

    const checkParams = (mockCache.llm.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(checkParams.temperature).toBe(0.7);
    expect(checkParams.max_tokens).toBe(256);
  });

  it('stream miss passes chunks through and stores the aggregate', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    const chunks: string[] = [];
    for await (const c of await model.stream([new HumanMessage('Hi')])) {
      chunks.push(typeof c.content === 'string' ? c.content : '');
    }

    expect(chunks).toEqual(['cached', '-', 'response']);
    expect(inner.streamCount).toBe(1);
    expect(mockCache.llm.store).toHaveBeenCalledWith(
      expect.any(Object),
      'cached-response',
      expect.anything(),
    );
  });

  it('stream hit replays a single chunk without calling the model', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: true,
      response: 'cached-response',
      tier: 'llm',
    } as LlmCacheResult);

    const chunks: string[] = [];
    for await (const c of await model.stream([new HumanMessage('Hi')])) {
      chunks.push(typeof c.content === 'string' ? c.content : '');
    }

    expect(chunks).toEqual(['cached-response']);
    expect(inner.streamCount).toBe(0);
    expect(inner.callCount).toBe(0);
  });

  it('cache read failure falls through to inner model', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('valkey down'));
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    const result = await model.invoke([new HumanMessage('Hi')]);

    expect(inner.callCount).toBe(1);
    expect((result as AIMessage).content).toBe('cached-response');
  });

  it('store failure is fail-open', async () => {
    const mockCache = createMockAgentCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });

    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('store failed'));

    const result = await model.invoke([new HumanMessage('Hi')]);

    expect(inner.callCount).toBe(1);
    expect((result as AIMessage).content).toBe('cached-response');
  });

  const missAll = (c: AgentCache) => {
    (c.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, tier: 'llm' } as LlmCacheResult);
    (c.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');
  };
  const checkCall = (c: AgentCache, i: number) =>
    (c.llm.check as ReturnType<typeof vi.fn>).mock.calls[i][0];

  it('tool schema key order does not change the cache key', async () => {
    const { llmCacheHash } = await import('../../utils');
    const mockCache = createMockAgentCache();
    missAll(mockCache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache: mockCache });
    const a = { type: 'function' as const, function: { name: 't', parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'] } } };
    const b = { type: 'function' as const, function: { parameters: { required: ['a', 'b'], properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' }, name: 't' } };
    await model.bindTools([a]).invoke([new HumanMessage('x')]);
    await model.bindTools([b]).invoke([new HumanMessage('x')]);
    expect(llmCacheHash(checkCall(mockCache, 0))).toBe(llmCacheHash(checkCall(mockCache, 1)));
  });

  it('invoke and stream build identical cache params', async () => {
    const mockCache = createMockAgentCache();
    missAll(mockCache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache: mockCache });
    const bound = model.bindTools([weatherTool]);
    await bound.invoke([new HumanMessage('x')]);
    for await (const _ of await bound.stream([new HumanMessage('x')])) { /* drain */ }
    expect(checkCall(mockCache, 1)).toEqual(checkCall(mockCache, 0));
  });

  it('unrelated per-request options (user, apiKey) do not change the key', async () => {
    const mockCache = createMockAgentCache();
    missAll(mockCache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache: mockCache });
    await model.invoke([new HumanMessage('x')]);
    await model.invoke([new HumanMessage('x')], { user: 'u1', apiKey: 'k' } as never);
    expect(checkCall(mockCache, 1)).toEqual(checkCall(mockCache, 0));
  });

  it('withStructuredOutput schema participates in the cache key', async () => {
    const mockCache = createMockAgentCache();
    missAll(mockCache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache: mockCache });
    await model.withStructuredOutput(z.object({ city: z.string() })).invoke('x').catch(() => undefined);
    await model.withStructuredOutput(z.object({ city: z.string(), units: z.string() })).invoke('x').catch(() => undefined);
    const calls = (mockCache.llm.check as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0][0].tools)).not.toBe(JSON.stringify(calls[1][0].tools));
  });

  it('bindTools does not mutate the original instance', async () => {
    const mockCache = createMockAgentCache();
    missAll(mockCache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache: mockCache });
    model.bindTools([weatherTool]);
    await model.invoke([new HumanMessage('x')]);
    expect(checkCall(mockCache, 0).tools).toBeUndefined();
  });

  it('different image content produces a different key', async () => {
    const mockCache = createMockAgentCache();
    missAll(mockCache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache: mockCache });
    const msg = (url: string) => new HumanMessage({
      content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url } }],
    });
    await model.invoke([msg('https://a/1.png')]);
    await model.invoke([msg('https://a/2.png')]);
    expect(JSON.stringify(checkCall(mockCache, 0).messages)).not.toBe(
      JSON.stringify(checkCall(mockCache, 1).messages),
    );
  });

  it('stream store failure still delivers all chunks', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, tier: 'llm' } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('store failed'));
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache: mockCache });
    const chunks: string[] = [];
    for await (const c of await model.stream([new HumanMessage('Hi')])) {
      chunks.push(typeof c.content === 'string' ? c.content : '');
    }
    expect(chunks).toEqual(['cached', '-', 'response']);
  });

  it('bypasses the cache when any bound tool fails conversion', async () => {
    const mockCache = createMockAgentCache();
    missAll(mockCache);
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const bound = model.bindTools([weatherTool, { unconvertible: true }]);

    await bound.invoke([new HumanMessage('x')]);
    await bound.invoke([new HumanMessage('x')]);

    expect(inner.callCount).toBe(2);
    expect(mockCache.llm.check).not.toHaveBeenCalled();
    expect(mockCache.llm.store).not.toHaveBeenCalled();
    expect(mockCache.llm.storeMultipart).not.toHaveBeenCalled();
  });

  it('streams array-content chunks as text, each token reported exactly once', async () => {
    const mockCache = createMockAgentCache();
    missAll(mockCache);
    const inner = new FakeChatModel({});
    // Like real providers, the wrapped model reports its own tokens.
    inner._streamResponseChunks = async function* (_m, _o, runManager) {
      const chunk = new ChatGenerationChunk({
        text: 'hi',
        message: new AIMessageChunk({ content: [{ type: 'text', text: 'hi' }] }),
      });
      await runManager?.handleLLMNewToken('hi', undefined, undefined, undefined, undefined, { chunk });
      yield chunk;
    } as FakeChatModel['_streamResponseChunks'];
    const model = new CachedChatModel({ model: inner, cache: mockCache });
    const tokens: string[] = [];
    const texts: string[] = [];
    const handler = { handleLLMNewToken: (t: string) => { tokens.push(t); } };

    for await (const c of await model.stream([new HumanMessage('x')], { callbacks: [handler] })) {
      texts.push(c.text);
    }

    expect(texts).toEqual(['hi']);
    expect(tokens).toEqual(['hi']);
  });
});

// ── Review fixes: key coverage, faithful replay, structured output, callbacks ──

const missAll = (c: AgentCache) => {
  (c.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, tier: 'llm' } as LlmCacheResult);
  (c.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');
  (c.llm.storeMultipart as ReturnType<typeof vi.fn>).mockResolvedValue('key');
};
const checkCall = (c: AgentCache, i: number) =>
  (c.llm.check as ReturnType<typeof vi.fn>).mock.calls[i][0];

/** In-memory Valkey stand-in: enough of get/set/del/pipeline for LlmCache. */
function createMemoryValkey(): Valkey {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    pipeline: vi.fn(() => ({
      hincrby: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  } as unknown as Valkey;
}

function createNoopTelemetry(): Telemetry {
  return {
    tracer: {
      startActiveSpan: vi.fn((_name, fn) => fn({ setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() })),
    },
    metrics: {
      requestsTotal: { labels: vi.fn(() => ({ inc: vi.fn() })) },
      operationDuration: { labels: vi.fn(() => ({ observe: vi.fn() })) },
      costSaved: { labels: vi.fn(() => ({ inc: vi.fn() })) },
      storedBytes: { labels: vi.fn(() => ({ inc: vi.fn() })) },
      activeSessions: { labels: vi.fn(() => ({ inc: vi.fn(), dec: vi.fn(), set: vi.fn() })) },
    },
  } as unknown as Telemetry;
}

/** A real LlmCache over in-memory storage, so keys and stored entries are genuine. */
function createRealCache(): AgentCache & { llm: LlmCache } {
  const llm = new LlmCache({
    client: createMemoryValkey(),
    name: 'test_ac',
    defaultTtl: undefined,
    tierTtl: undefined,
    costTable: undefined,
    telemetry: createNoopTelemetry(),
    statsKey: 'test_ac:__stats',
  });
  vi.spyOn(llm, 'check');
  vi.spyOn(llm, 'storeMultipart');
  vi.spyOn(llm, 'store');
  return { llm } as unknown as AgentCache & { llm: LlmCache };
}

/** A fake model whose invocationParams() echoes call options, like ChatOpenAI/ChatAnthropic. */
class ParamsFakeChatModel extends FakeChatModel {
  constructorParams: Record<string, unknown> = { model: 'fake', temperature: 0.7, max_tokens: 256 };
  bindToolsCalls: Array<{ tools: unknown[]; kwargs?: unknown }> = [];
  lastOptions?: Record<string, unknown>;

  invocationParams(options?: Record<string, unknown>): Record<string, unknown> {
    const { tools: _t, callbacks: _c, signal: _s, ...rest } = options ?? {};
    return { ...this.constructorParams, stream: false, ...rest };
  }

  bindTools(
    tools: unknown[],
    kwargs?: Partial<FakeCallOptions>,
  ): ReturnType<NonNullable<BaseChatModel['bindTools']>> {
    this.bindToolsCalls.push({ tools, kwargs });
    return super.bindTools(tools, kwargs);
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.lastOptions = options as Record<string, unknown>;
    return super._generate(messages, options, runManager);
  }
}

/** What ChatAnthropic returns for extended thinking + a tool call. */
function anthropicThinkingToolMessage(): AIMessage {
  return new AIMessage({
    id: 'msg_01ABC',
    content: [
      { type: 'thinking', thinking: 'The user wants weather.', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'opaque-redacted' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Sofia' } },
    ],
    tool_calls: [{ id: 'toolu_1', name: 'get_weather', args: { city: 'Sofia' }, type: 'tool_call' }],
    invalid_tool_calls: [{ id: 'toolu_2', name: 'get_weather', args: '{"city":', error: 'bad json', type: 'invalid_tool_call' }],
    additional_kwargs: { stop_reason_detail: 'x' },
    response_metadata: { model_name: 'claude-sonnet', stop_reason: 'tool_use', model_provider: 'anthropic' },
  });
}

describe('CachedChatModel cache key covers all invocation params', () => {
  let CachedChatModel: typeof import('../langchain').CachedChatModel;
  beforeEach(async () => {
    ({ CachedChatModel } = await import('../langchain'));
  });

  const keyFor = async (
    configure: (m: ParamsFakeChatModel) => void,
    callOptions: Record<string, unknown> = {},
  ): Promise<LlmCacheParams> => {
    const cache = createMockAgentCache();
    (cache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, tier: 'llm' });
    const inner = new ParamsFakeChatModel({});
    configure(inner);
    const model = new CachedChatModel({ model: inner, cache });
    await model.invoke([new HumanMessage('x')], callOptions as never);
    return (cache.llm.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
  };

  it('maps response_format, reasoning_effort, stop_sequences and prompt_cache_key onto first-class fields', async () => {
    const params = await keyFor((m) => {
      m.constructorParams = {
        model: 'fake',
        stop_sequences: ['END'],
        reasoning_effort: 'high',
        prompt_cache_key: 'pck',
      };
    }, { response_format: { type: 'json_object' } });
    expect(params.responseFormat).toEqual({ type: 'json_object' });
    expect(params.reasoningEffort).toBe('high');
    expect(params.stop).toEqual(['END']);
    expect(params.promptCacheKey).toBe('pck');
    expect(params.providerParams).toBeUndefined();
  });

  it.each([
    ['response_format', { type: 'json_schema', json_schema: { name: 'x', schema: {} } }],
    ['parallel_tool_calls', false],
    ['max_completion_tokens', 50],
    ['reasoning_effort', 'low'],
    ['reasoning', { effort: 'low', summary: 'auto' }],
    ['thinking', { type: 'enabled', budget_tokens: 1024 }],
    ['top_k', 5],
    ['frequency_penalty', 0.5],
    ['presence_penalty', 0.5],
    ['n', 2],
    ['stop_sequences', ['END']],
  ])('%s changes the cache key', async (name, value) => {
    const base = await keyFor(() => {});
    const changed = await keyFor((m) => { m.constructorParams = { ...m.constructorParams, [name]: value }; });
    expect(llmCacheHash(changed)).not.toBe(llmCacheHash(base));
  });

  it('call-option parallel_tool_calls (bindTools kwargs) changes the key', async () => {
    const cache = createMockAgentCache();
    (cache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, tier: 'llm' });
    const model = new CachedChatModel({ model: new ParamsFakeChatModel({}), cache });
    await model.bindTools([weatherTool]).invoke([new HumanMessage('x')]);
    await model.bindTools([weatherTool], { parallel_tool_calls: false } as never).invoke([new HumanMessage('x')]);
    const calls = (cache.llm.check as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0].providerParams).toEqual({ parallel_tool_calls: false });
    expect(llmCacheHash(calls[0][0])).not.toBe(llmCacheHash(calls[1][0]));
  });

  it('transport and runtime keys never enter the key', async () => {
    const params = await keyFor((m) => {
      m.constructorParams = {
        model: 'fake',
        stream: true,
        stream_options: { include_usage: true },
        timeout: 1000,
        model_name: 'other',
      };
    });
    expect(params.providerParams).toBeUndefined();
    expect(params.model).toBe('fake');
  });

  it('modelName override still wins over invocationParams().model', async () => {
    const cache = createMockAgentCache();
    (cache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, tier: 'llm' });
    const model = new CachedChatModel({ model: new ParamsFakeChatModel({}), cache, modelName: 'pinned' });
    await model.invoke([new HumanMessage('x')]);
    const params = (cache.llm.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params.model).toBe('pinned');
    expect(params.providerParams).toBeUndefined();
  });
});

describe('CachedChatModel replays responses faithfully', () => {
  let CachedChatModel: typeof import('../langchain').CachedChatModel;
  beforeEach(async () => {
    ({ CachedChatModel } = await import('../langchain'));
  });

  it('round-trips thinking blocks, signatures, tool_use parts and message metadata through a real LlmCache', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    const live = anthropicThinkingToolMessage();
    inner.response = live;
    const model = new CachedChatModel({ model: inner, cache }).bindTools([weatherTool]);
    const messages = [new HumanMessage('Weather in Sofia?')];

    await model.invoke(messages);
    const hit = (await model.invoke(messages)) as AIMessage;

    expect(inner.callCount).toBe(1);
    expect(cache.llm.storeMultipart).toHaveBeenCalledTimes(1);
    const stored = (cache.llm.storeMultipart as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored).toEqual([
      { type: 'reasoning', text: 'The user wants weather.', opaqueSignature: 'sig-abc' },
      { type: 'reasoning', text: '', redacted: true, opaqueSignature: 'opaque-redacted' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_call', id: 'toolu_1', name: 'get_weather', args: { city: 'Sofia' } },
    ]);

    expect(hit.content).toEqual(live.content);
    expect(hit.tool_calls).toEqual(live.tool_calls);
    expect(hit.invalid_tool_calls).toEqual(live.invalid_tool_calls);
    // The stored response's id is not replayed (see the id tests below).
    expect(hit.id).not.toBe('msg_01ABC');
    expect(hit.additional_kwargs).toEqual(live.additional_kwargs);
    expect(hit.response_metadata).toEqual(expect.objectContaining(live.response_metadata));
  });

  it('keeps string content as a string on replay (OpenAI shape)', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    inner.response = new AIMessage({
      id: 'chatcmpl-1',
      content: 'Let me check.',
      tool_calls: [{ id: 'call_1', name: 'get_weather', args: { city: 'Sofia' }, type: 'tool_call' }],
      additional_kwargs: { refusal: null },
      response_metadata: { finish_reason: 'tool_calls' },
    });
    const model = new CachedChatModel({ model: inner, cache }).bindTools([weatherTool]);

    await model.invoke([new HumanMessage('x')]);
    const hit = (await model.invoke([new HumanMessage('x')])) as AIMessage;

    expect(inner.callCount).toBe(1);
    expect(hit.content).toBe('Let me check.');
    expect(hit.id).not.toBe('chatcmpl-1');
    expect(hit.tool_calls).toEqual(inner.response.tool_calls);
  });

  it('turn 2 still hits after turn 1 was served from the cache (Anthropic tool loop)', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache }).bindTools([weatherTool]);
    const question = new HumanMessage('Weather in Sofia?');

    const runConversation = async () => {
      inner.response = anthropicThinkingToolMessage();
      const turn1 = (await model.invoke([question])) as AIMessage;
      inner.response = new AIMessage({ content: [{ type: 'text', text: 'It is sunny.' }] });
      const history = [question, turn1, new ToolMessage({ tool_call_id: 'toolu_1', content: 'sunny' })];
      await model.invoke(history);
      const checks = (cache.llm.check as ReturnType<typeof vi.fn>).mock.calls;
      return llmCacheHash(checks[checks.length - 1][0]);
    };

    const firstRunTurn2Key = await runConversation(); // turn 1 miss, turn 2 miss
    expect(inner.callCount).toBe(2);
    const secondRunTurn2Key = await runConversation(); // turn 1 replayed, turn 2 must hit
    expect(secondRunTurn2Key).toBe(firstRunTurn2Key);
    expect(inner.callCount).toBe(2);
  });

  it('a live and a replayed assistant message produce identical key blocks', async () => {
    const cache = createMockAgentCache();
    (cache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, tier: 'llm' });
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache });
    const live = anthropicThinkingToolMessage();
    const replayed = new AIMessage({
      content: 'Let me check.',
      tool_calls: live.tool_calls,
    });

    await model.invoke([new HumanMessage('q'), live]);
    const liveBlocks = (cache.llm.check as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[1].content;
    expect(liveBlocks).not.toContainEqual(expect.objectContaining({ text: expect.stringContaining('[tool_use]') }));
    expect(liveBlocks).toContainEqual({ type: 'reasoning', text: 'The user wants weather.', opaqueSignature: 'sig-abc' });

    await model.invoke([new HumanMessage('q'), replayed]);
    const replayedBlocks = (cache.llm.check as ReturnType<typeof vi.fn>).mock.calls[1][0].messages[1].content;
    // Same text + tool call; the live one additionally carries its reasoning blocks.
    expect(liveBlocks.filter((b: { type: string }) => b.type !== 'reasoning')).toEqual(replayedBlocks);
  });

  it('stream hit carries tool_call_chunks, tool_calls and metadata in the replayed chunk', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    inner.response = anthropicThinkingToolMessage();
    const model = new CachedChatModel({ model: inner, cache }).bindTools([weatherTool]);
    await model.invoke([new HumanMessage('x')]);

    const tokenFields: unknown[] = [];
    const handler = {
      handleLLMNewToken: (_t: string, _i: unknown, _r: unknown, _p: unknown, _tags: unknown, fields?: { chunk?: unknown }) => {
        tokenFields.push(fields?.chunk);
      },
    };
    const chunks: AIMessageChunk[] = [];
    for await (const c of await model.stream([new HumanMessage('x')], { callbacks: [handler] })) {
      chunks.push(c as AIMessageChunk);
    }

    expect(inner.streamCount).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].tool_call_chunks).toEqual([
      { id: 'toolu_1', name: 'get_weather', args: '{"city":"Sofia"}', index: 0, type: 'tool_call_chunk' },
    ]);
    expect(chunks[0].tool_calls).toEqual([
      { id: 'toolu_1', name: 'get_weather', args: { city: 'Sofia' }, type: 'tool_call' },
    ]);
    expect(chunks[0].invalid_tool_calls).toEqual(anthropicThinkingToolMessage().invalid_tool_calls);
    expect(chunks[0].id).not.toBe('msg_01ABC');
    expect(chunks[0].content).toEqual(anthropicThinkingToolMessage().content);
    // LangGraph streamMode "messages" reads the chunk from the token callback.
    expect(tokenFields).toHaveLength(1);
    expect(tokenFields[0]).toBeInstanceOf(ChatGenerationChunk);
  });

  it('stores a streamed Anthropic response (parts merged by index) and replays it', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    const parts = [
      { content: [{ index: 0, type: 'thinking', thinking: 'The user ' }] },
      { content: [{ index: 0, type: 'thinking', thinking: 'wants weather.' }] },
      { content: [{ index: 0, type: 'thinking', signature: 'sig-abc' }] },
      { content: [{ index: 1, type: 'text', text: 'Let me check.' }] },
      {
        content: [{ index: 2, type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: '' }],
        tool_call_chunks: [{ index: 2, id: 'toolu_1', name: 'get_weather', args: '' }],
      },
      {
        content: [{ index: 2, type: 'input_json_delta', input: '{"city":"Sofia"}' }],
        tool_call_chunks: [{ index: 2, args: '{"city":"Sofia"}' }],
      },
    ];
    inner._streamResponseChunks = async function* () {
      for (const p of parts) {
        yield new ChatGenerationChunk({ text: '', message: new AIMessageChunk(p as never) });
      }
    } as FakeChatModel['_streamResponseChunks'];
    const model = new CachedChatModel({ model: inner, cache }).bindTools([weatherTool]);

    for await (const _ of await model.stream([new HumanMessage('x')])) { /* drain */ }
    const hit = (await model.invoke([new HumanMessage('x')])) as AIMessage;

    expect((cache.llm.storeMultipart as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      { type: 'reasoning', text: 'The user wants weather.', opaqueSignature: 'sig-abc' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_call', id: 'toolu_1', name: 'get_weather', args: { city: 'Sofia' } },
    ]);
    expect(inner.callCount).toBe(0);
    expect(hit.content).toEqual([
      { type: 'thinking', thinking: 'The user wants weather.', signature: 'sig-abc' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Sofia' } },
    ]);
  });

  it('does not cache content it cannot replay faithfully (e.g. citations)', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    inner.response = new AIMessage({
      content: [{ type: 'text', text: 'Sofia is sunny.', citations: [{ url: 'https://x' }] }],
    });
    const model = new CachedChatModel({ model: inner, cache });

    const first = (await model.invoke([new HumanMessage('x')])) as AIMessage;
    await model.invoke([new HumanMessage('x')]);

    expect(first.content).toEqual(inner.response.content);
    expect(cache.llm.store).not.toHaveBeenCalled();
    expect(cache.llm.storeMultipart).not.toHaveBeenCalled();
    expect(inner.callCount).toBe(2);
  });
});

describe('CachedChatModel withStructuredOutput', () => {
  let CachedChatModel: typeof import('../langchain').CachedChatModel;
  beforeEach(async () => {
    ({ CachedChatModel } = await import('../langchain'));
  });

  it('forces the schema tool with tool_choice "any" and parses the result', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const inner = new ParamsFakeChatModel({});
    inner.response = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 'extract', args: { city: 'Sofia' }, type: 'tool_call' }],
    });
    const model = new CachedChatModel({ model: inner, cache });

    const out = await model.withStructuredOutput(z.object({ city: z.string() })).invoke('x');

    expect(out).toEqual({ city: 'Sofia' });
    expect(checkCall(cache, 0).toolChoice).toBe('any');
    expect(inner.lastOptions?.tool_choice).toBe('any');
    expect(inner.bindToolsCalls[0].kwargs).toEqual(expect.objectContaining({ tool_choice: 'any' }));
  });

  it('does not force a tool while extended thinking is on (Anthropic rejects it)', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const inner = new ParamsFakeChatModel({});
    inner.constructorParams = { model: 'claude', thinking: { type: 'enabled', budget_tokens: 1024 } };
    const model = new CachedChatModel({ model: inner, cache });

    await model.withStructuredOutput(z.object({ city: z.string() })).invoke('x').catch(() => undefined);

    expect(checkCall(cache, 0).toolChoice).toBeUndefined();
  });

  it('includeRaw returns the raw message alongside the parsed output', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const inner = new ParamsFakeChatModel({});
    inner.response = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 'extract', args: { city: 'Sofia' }, type: 'tool_call' }],
    });
    const model = new CachedChatModel({ model: inner, cache });

    const out = await model
      .withStructuredOutput(z.object({ city: z.string() }), { includeRaw: true })
      .invoke('x');

    expect(out.parsed).toEqual({ city: 'Sofia' });
    expect((out.raw as AIMessage).tool_calls?.[0].name).toBe('extract');
  });

  it('parses a structured-output response replayed from the cache', async () => {
    const cache = createRealCache();
    const inner = new ParamsFakeChatModel({});
    inner.response = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 'extract', args: { city: 'Sofia' }, type: 'tool_call' }],
    });
    const structured = new CachedChatModel({ model: inner, cache })
      .withStructuredOutput(z.object({ city: z.string() }));

    await structured.invoke('x');
    const fromCache = await structured.invoke('x');

    expect(fromCache).toEqual({ city: 'Sofia' });
    expect(inner.callCount).toBe(1);
  });

  it('does not change bindTools on the original instance', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const model = new CachedChatModel({ model: new ParamsFakeChatModel({}), cache });
    model.withStructuredOutput(z.object({ city: z.string() }));
    await model.bindTools([weatherTool]).invoke([new HumanMessage('x')]);
    expect(checkCall(cache, 0).toolChoice).toBeUndefined();
  });
});

describe('CachedChatModel callbacks and tool binding', () => {
  let CachedChatModel: typeof import('../langchain').CachedChatModel;
  beforeEach(async () => {
    ({ CachedChatModel } = await import('../langchain'));
  });

  const recordRuns = () => {
    const runs: Array<{ runId: string; parentRunId?: string; name?: string }> = [];
    const handler = {
      handleChatModelStart: (
        llm: { id?: string[] },
        _m: unknown,
        runId: string,
        parentRunId?: string,
      ) => {
        runs.push({ runId, parentRunId, name: llm.id?.[llm.id.length - 1] });
      },
    };
    return { runs, handler };
  };

  it.each(['invoke', 'stream'] as const)('%s on a miss traces the wrapped model as a child run', async (mode) => {
    const cache = createMockAgentCache();
    missAll(cache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache });
    const { runs, handler } = recordRuns();

    if (mode === 'invoke') {
      await model.invoke([new HumanMessage('x')], { callbacks: [handler] });
    } else {
      for await (const _ of await model.stream([new HumanMessage('x')], { callbacks: [handler] })) { /* drain */ }
    }

    expect(runs).toHaveLength(2);
    const [outer, child] = runs;
    expect(outer.parentRunId).toBeUndefined();
    expect(child.parentRunId).toBe(outer.runId);
  });

  it('reports the wrapped model LangSmith params', () => {
    const inner = new FakeChatModel({});
    inner.getLsParams = () => ({ ls_provider: 'openai', ls_model_name: 'gpt-4o-mini', ls_model_type: 'chat' });
    const model = new CachedChatModel({ model: inner, cache: createMockAgentCache() });
    expect(model.getLsParams({} as never)).toEqual(
      expect.objectContaining({ ls_provider: 'openai', ls_model_name: 'gpt-4o-mini' }),
    );
  });

  it('re-applies bindTools kwargs (e.g. strict) when binding onto the wrapped model', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const inner = new ParamsFakeChatModel({});
    const model = new CachedChatModel({ model: inner, cache });
    await model.bindTools([weatherTool], { strict: true }).invoke([new HumanMessage('x')]);
    expect(inner.bindToolsCalls[0].kwargs).toEqual({ strict: true });
  });

  it('strict and non-strict tools get different keys', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache });
    const strictTool = { ...weatherTool, function: { ...weatherTool.function, strict: true } };
    await model.bindTools([weatherTool]).invoke([new HumanMessage('x')]);
    await model.bindTools([strictTool]).invoke([new HumanMessage('x')]);
    await model.bindTools([weatherTool], { strict: true }).invoke([new HumanMessage('x')]);
    const [plain, perTool, kwarg] = [0, 1, 2].map((i) => checkCall(cache, i));
    expect(llmCacheHash(plain)).not.toBe(llmCacheHash(perTool));
    expect(perTool.tools[0].function.strict).toBe(true);
    expect(llmCacheHash(kwarg)).toBe(llmCacheHash(perTool));
  });

  it('bindTools throws when the wrapped model cannot bind tools', () => {
    const inner = new FakeChatModel({});
    (inner as unknown as { bindTools?: unknown }).bindTools = undefined;
    const model = new CachedChatModel({ model: inner, cache: createMockAgentCache() });
    expect(() => model.bindTools([weatherTool])).toThrow(/does not implement bindTools/);
  });

  it('keys Anthropic-native tool definitions instead of bypassing the cache', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache });
    const anthropicTool = {
      name: 'get_weather',
      description: 'Get weather for a city',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    };
    await model.bindTools([anthropicTool]).invoke([new HumanMessage('x')]);
    await model.bindTools([weatherTool]).invoke([new HumanMessage('x')]);
    expect(cache.llm.check).toHaveBeenCalledTimes(2);
    expect(llmCacheHash(checkCall(cache, 0))).toBe(llmCacheHash(checkCall(cache, 1)));
  });

  it('warns once per process when a tool forces a cache bypass', async () => {
    vi.resetModules();
    const { CachedChatModel: Fresh } = await import('../langchain');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cache = createMockAgentCache();
      missAll(cache);
      const bound = new Fresh({ model: new FakeChatModel({}), cache })
        .bindTools([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
      await bound.invoke([new HumanMessage('x')]);
      await bound.invoke([new HumanMessage('x')]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(cache.llm.check).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ── Review fixes (round 2): replayed message ids, constructor-level callbacks ──

/** Like real streaming providers: each chunk is also reported through the run's callbacks. */
function emitTokensWhileStreaming(inner: FakeChatModel): void {
  inner._streamResponseChunks = async function* (_m, _o, runManager) {
    for (const t of this.streamChunks) {
      const chunk = new ChatGenerationChunk({ text: t, message: new AIMessageChunk({ content: t }) });
      await runManager?.handleLLMNewToken(t, undefined, undefined, undefined, undefined, { chunk });
      yield chunk;
    }
  } as FakeChatModel['_streamResponseChunks'];
}

function recordTokens() {
  const tokens: Array<{ token: string; runId: string }> = [];
  const handler = {
    handleLLMNewToken: (token: string, _idx: unknown, runId: string) => {
      tokens.push({ token, runId });
    },
  };
  return { tokens, handler };
}

/** Records the outermost chat-model run, which is the CachedChatModel's own run. */
function recordOuterRun() {
  const runIds: string[] = [];
  const handler = {
    handleChatModelStart: (_llm: unknown, _m: unknown, runId: string, parentRunId?: string) => {
      if (parentRunId === undefined) runIds.push(runId);
    },
  };
  return { runIds, handler };
}

describe('CachedChatModel replayed message ids', () => {
  let CachedChatModel: typeof import('../langchain').CachedChatModel;
  beforeEach(async () => {
    ({ CachedChatModel } = await import('../langchain'));
  });

  // Any handler gives the call a run, so BaseChatModel assigns `run-<runId>` to an id-less message.
  const noop = { handleLLMStart: () => {} };

  it('does not store the response id in the entry metadata', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    inner.response = anthropicThinkingToolMessage();
    await new CachedChatModel({ model: inner, cache }).bindTools([weatherTool]).invoke([new HumanMessage('x')]);

    const options = (cache.llm.storeMultipart as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(options.metadata).not.toHaveProperty('id');
  });

  it('two invoke hits of the same entry get distinct fresh ids, never the stored one', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    inner.response = anthropicThinkingToolMessage();
    const model = new CachedChatModel({ model: inner, cache }).bindTools([weatherTool]);
    const messages = [new HumanMessage('Weather in Sofia?')];

    const miss = (await model.invoke(messages, { callbacks: [noop] })) as AIMessage;
    const hit1 = (await model.invoke(messages, { callbacks: [noop] })) as AIMessage;
    const hit2 = (await model.invoke(messages, { callbacks: [noop] })) as AIMessage;

    expect(inner.callCount).toBe(1);
    expect(miss.id).toBe('msg_01ABC'); // a miss returns the provider's message untouched
    expect(hit1.id).toMatch(/^run-/);
    expect(hit2.id).toMatch(/^run-/);
    expect(hit1.id).not.toBe(hit2.id);
  });

  it('two streamed hits of the same entry get distinct fresh ids, never the stored one', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    inner.response = anthropicThinkingToolMessage();
    const model = new CachedChatModel({ model: inner, cache }).bindTools([weatherTool]);
    const messages = [new HumanMessage('Weather in Sofia?')];
    await model.invoke(messages);

    const streamedIds: Array<string | undefined> = [];
    for (let i = 0; i < 2; i++) {
      for await (const c of await model.stream(messages, { callbacks: [noop] })) streamedIds.push(c.id);
    }

    expect(inner.streamCount).toBe(0);
    expect(streamedIds).toHaveLength(2);
    expect(streamedIds[0]).toMatch(/^run-/);
    expect(streamedIds[1]).toMatch(/^run-/);
    expect(streamedIds[0]).not.toBe(streamedIds[1]);
  });
});

describe('CachedChatModel constructor-level callbacks', () => {
  let CachedChatModel: typeof import('../langchain').CachedChatModel;
  beforeEach(async () => {
    ({ CachedChatModel } = await import('../langchain'));
  });

  it('a constructor-level handler gets each token once on a streamed miss, under the outer run id', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const inner = new FakeChatModel({});
    emitTokensWhileStreaming(inner);
    const { tokens, handler } = recordTokens();
    const outer = recordOuterRun();
    const model = new CachedChatModel({ model: inner, cache, callbacks: [handler] });

    const texts: string[] = [];
    for await (const c of await model.stream([new HumanMessage('x')], { callbacks: [outer.handler] })) {
      texts.push(c.text);
    }

    expect(texts).toEqual(['cached', '-', 'response']);
    expect(tokens.map((t) => t.token)).toEqual(['cached', '-', 'response']);
    expect(outer.runIds).toHaveLength(1);
    expect(new Set(tokens.map((t) => t.runId))).toEqual(new Set(outer.runIds));
  });

  it('a constructor-level handler gets the replayed token once on a streamed hit', async () => {
    const cache = createRealCache();
    const inner = new FakeChatModel({});
    inner.response = new AIMessage('cached-response');
    emitTokensWhileStreaming(inner);
    const { tokens, handler } = recordTokens();
    const model = new CachedChatModel({ model: inner, cache, callbacks: [handler] });
    await model.invoke([new HumanMessage('x')]); // populate

    for await (const _ of await model.stream([new HumanMessage('x')])) { /* drain */ }

    expect(inner.streamCount).toBe(0);
    expect(tokens.map((t) => t.token)).toEqual(['cached-response']);
  });

  it('constructor-level and call-level handlers each see every token exactly once on a miss', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const inner = new FakeChatModel({});
    emitTokensWhileStreaming(inner);
    const local = recordTokens();
    const inherited = recordTokens();
    const model = new CachedChatModel({ model: inner, cache, callbacks: [local.handler] });

    for await (const _ of await model.stream([new HumanMessage('x')], { callbacks: [inherited.handler] })) {
      /* drain */
    }

    expect(local.tokens.map((t) => t.token)).toEqual(['cached', '-', 'response']);
    expect(inherited.tokens.map((t) => t.token)).toEqual(['cached', '-', 'response']);
  });

  it('forwards tokens a wrapped model emits from invoke (e.g. streaming: true) to a constructor-level handler', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const inner = new FakeChatModel({});
    inner._generate = async function (_m, _o, runManager) {
      this.callCount += 1;
      await runManager?.handleLLMNewToken('hello', undefined, undefined, undefined, undefined, undefined);
      return { generations: [{ text: 'hello', message: new AIMessage('hello') }] };
    } as FakeChatModel['_generate'];
    const { tokens, handler } = recordTokens();
    const model = new CachedChatModel({ model: inner, cache, callbacks: [handler] });

    await model.invoke([new HumanMessage('x')]);

    expect(inner.callCount).toBe(1);
    expect(tokens.map((t) => t.token)).toEqual(['hello']);
  });

  it('does not leak constructor-level handlers into the wrapped model run', async () => {
    const cache = createMockAgentCache();
    missAll(cache);
    const starts: Array<string | undefined> = [];
    const handler = {
      handleChatModelStart: (_l: unknown, _m: unknown, _runId: string, parentRunId?: string) => {
        starts.push(parentRunId);
      },
    };
    const model = new CachedChatModel({ model: new FakeChatModel({}), cache, callbacks: [handler] });

    await model.invoke([new HumanMessage('x')]);

    // Only the wrapper's own run; the wrapped model's child run is not reported to it.
    expect(starts).toEqual([undefined]);
  });
});
