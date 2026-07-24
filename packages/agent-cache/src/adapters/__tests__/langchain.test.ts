import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { AgentCache } from '../../AgentCache';
import type { LlmCacheResult } from '../../types';

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
      { id: 'call_1', name: 'get_weather', args: { city: 'Sofia' } },
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
      { tokens: { input: 12, output: 4 } },
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
});
