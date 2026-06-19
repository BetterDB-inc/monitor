import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AgentCache } from '../../AgentCache';
import type { LlmCacheParams, LlmCacheResult } from '../../types';

function createMockAgentCache(): AgentCache {
  return {
    llm: {
      check: vi.fn(),
      store: vi.fn(),
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

function makeMockParams() {
  return {
    model: { modelId: 'gpt-4o', provider: 'openai' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('wrapStream', () => {
  let createAgentCacheMiddleware: typeof import('../ai').createAgentCacheMiddleware;

  beforeEach(async () => {
    const module = await import('../ai');
    createAgentCacheMiddleware = module.createAgentCacheMiddleware;
  });

  function makeMockStream(parts: LanguageModelV3StreamPart[]) {
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      }),
    };
  }

  async function readStreamText(
    stream: ReadableStream<LanguageModelV3StreamPart>,
  ): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.type === 'text-delta') out += value.delta;
    }
    return out;
  }

  async function readAllStreamParts(
    stream: ReadableStream<LanguageModelV3StreamPart>,
  ): Promise<LanguageModelV3StreamPart[]> {
    const reader = stream.getReader();
    const parts: LanguageModelV3StreamPart[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parts.push(value);
    }
    return parts;
  }

  const finishPart: LanguageModelV3StreamPart = {
    type: 'finish',
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 3, text: undefined, reasoning: undefined },
    },
  };

  it('stores on miss and serves from cache on second call', async () => {
    const stored = new Map<string, string>();
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockImplementation(async (params: LlmCacheParams) => {
      const key = JSON.stringify(params);
      const response = stored.get(key);
      if (response) {
        return { hit: true, response, tier: 'llm' } as LlmCacheResult;
      }
      return { hit: false, tier: 'llm' } as LlmCacheResult;
    });
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockImplementation(async (params: LlmCacheParams, response: string) => {
      stored.set(JSON.stringify(params), response);
      return 'key';
    });

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const params = makeMockParams();
    const doStream = vi.fn().mockResolvedValue(
      makeMockStream([
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: 'hello ' },
        { type: 'text-delta', id: '0', delta: 'world' },
        { type: 'text-end', id: '0' },
        finishPart,
      ]),
    );

    const first = await middleware.wrapStream!({ doStream, params });
    expect(await readStreamText(first.stream)).toBe('hello world');
    expect(doStream).toHaveBeenCalledTimes(1);

    await flushPromises();

    const doStreamSecond = vi.fn();
    const second = await middleware.wrapStream!({ doStream: doStreamSecond, params });
    expect(await readStreamText(second.stream)).toBe('hello world');
    expect(doStreamSecond).not.toHaveBeenCalled();
  });

  it('synthesized stream has providerMetadata.agentCache.hit on finish', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: true,
      response: 'cached text',
      tier: 'llm',
    } as LlmCacheResult);

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const doStream = vi.fn();

    const result = await middleware.wrapStream!({
      doStream,
      params: makeMockParams(),
    });

    expect(doStream).not.toHaveBeenCalled();

    const parts = await readAllStreamParts(result.stream);
    const text = parts
      .filter((p): p is Extract<LanguageModelV3StreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.delta)
      .join('');
    expect(text).toBe('cached text');

    const finish = parts.find((p) => p.type === 'finish');
    expect(finish?.providerMetadata?.agentCache?.hit).toBe(true);
  });

  it('does not store when stream contains a tool-call chunk', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);

    const upstreamParts: LanguageModelV3StreamPart[] = [
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'some text' },
      { type: 'text-end', id: '0' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'get_weather',
        input: '{"city":"Sofia"}',
      },
      finishPart,
    ];

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const result = await middleware.wrapStream!({
      doStream: vi.fn().mockResolvedValue(makeMockStream(upstreamParts)),
      params: makeMockParams(),
    });

    const received = await readAllStreamParts(result.stream);
    expect(received.map((p) => p.type)).toEqual(upstreamParts.map((p) => p.type));

    const toolCall = received.find((p) => p.type === 'tool-call');
    expect(toolCall).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'get_weather',
      input: '{"city":"Sofia"}',
    });

    await flushPromises();
    expect(mockCache.llm.store).not.toHaveBeenCalled();
  });

  it('does not store when upstream emits error chunk', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);

    const upstreamParts: LanguageModelV3StreamPart[] = [
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'partial' },
      { type: 'error', error: new Error('upstream failed') },
    ];

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const result = await middleware.wrapStream!({
      doStream: vi.fn().mockResolvedValue(makeMockStream(upstreamParts)),
      params: makeMockParams(),
    });

    const received = await readAllStreamParts(result.stream);
    expect(received).toHaveLength(3);
    expect(received[2]?.type).toBe('error');

    await flushPromises();
    expect(mockCache.llm.store).not.toHaveBeenCalled();
  });

  it('completes caller stream normally when store fails', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('store boom'));

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const result = await middleware.wrapStream!({
      doStream: vi.fn().mockResolvedValue(
        makeMockStream([
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'ok' },
          { type: 'text-end', id: '0' },
          finishPart,
        ]),
      ),
      params: makeMockParams(),
    });

    const unhandledRejections: unknown[] = [];
    const handler = (err: unknown) => unhandledRejections.push(err);
    process.on('unhandledRejection', handler);
    try {
      expect(await readStreamText(result.stream)).toBe('ok');
      await flushPromises();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});
