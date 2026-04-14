import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentCache } from '../AgentCache';
import type { LlmCacheResult } from '../types';

// Mock AgentCache for unit tests
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

describe('LangChain adapter', () => {
  // Dynamic import to handle optional peer dependency
  let BetterDBLlmCache: typeof import('../adapters/langchain').BetterDBLlmCache;

  beforeEach(async () => {
    const module = await import('../adapters/langchain');
    BetterDBLlmCache = module.BetterDBLlmCache;
  });

  it('lookup() returns null on miss', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);

    const adapter = new BetterDBLlmCache({ cache: mockCache });
    const result = await adapter.lookup('What is Valkey?', 'gpt-4o');

    expect(result).toBeNull();
  });

  it('lookup() returns Generation[] on hit', async () => {
    const mockCache = createMockAgentCache();
    const generations = [{ text: 'Valkey is a key-value store.' }];
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: true,
      response: JSON.stringify(generations),
      tier: 'llm',
    } as LlmCacheResult);

    const adapter = new BetterDBLlmCache({ cache: mockCache });
    const result = await adapter.lookup('What is Valkey?', 'gpt-4o');

    expect(result).toEqual(generations);
  });

  it('lookup() returns plain text wrapped in Generation on hit with non-JSON response', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: true,
      response: 'Plain text response',
      tier: 'llm',
    } as LlmCacheResult);

    const adapter = new BetterDBLlmCache({ cache: mockCache });
    const result = await adapter.lookup('What is Valkey?', 'gpt-4o');

    expect(result).toEqual([{ text: 'Plain text response' }]);
  });

  it('update() calls llm.store with JSON-serialized generations', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    const adapter = new BetterDBLlmCache({ cache: mockCache });
    const generations = [{ text: 'Valkey is a key-value store.' }];

    await adapter.update('What is Valkey?', 'gpt-4o', generations);

    expect(mockCache.llm.store).toHaveBeenCalledWith(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'What is Valkey?' }] },
      JSON.stringify(generations),
    );
  });
});

describe('Vercel AI SDK adapter', () => {
  let createAgentCacheMiddleware: typeof import('../adapters/ai').createAgentCacheMiddleware;

  beforeEach(async () => {
    const module = await import('../adapters/ai');
    createAgentCacheMiddleware = module.createAgentCacheMiddleware;
  });

  it('middleware returns cached result on hit, skipping doGenerate', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: true,
      response: 'Cached response',
      tier: 'llm',
    } as LlmCacheResult);

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const doGenerate = vi.fn();

    const result = await middleware.wrapGenerate!({
      doGenerate,
      params: {
        // In Vercel AI SDK, model is a LanguageModelV1 object with modelId
        model: { modelId: 'gpt-4o', provider: 'openai' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      },
    });

    expect(doGenerate).not.toHaveBeenCalled();
    expect((result as { content: Array<{ text: string }> }).content[0].text).toBe('Cached response');
  });

  it('middleware calls doGenerate on miss and stores result', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Generated response' }],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20 },
    });

    await middleware.wrapGenerate!({
      doGenerate,
      params: {
        model: { modelId: 'gpt-4o', provider: 'openai' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      },
    });

    expect(doGenerate).toHaveBeenCalled();
    expect(mockCache.llm.store).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
      'Generated response',
      { tokens: { input: 10, output: 20 } },
    );
  });

  it('middleware skips caching when response contains tool_call parts', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'Let me check that.' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'get_weather', args: { city: 'Sofia' } },
      ],
      finishReason: 'tool-calls',
      usage: { promptTokens: 10, completionTokens: 20 },
    });

    await middleware.wrapGenerate!({
      doGenerate,
      params: {
        model: { modelId: 'gpt-4o', provider: 'openai' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Sofia?' }] }],
      },
    });

    expect(doGenerate).toHaveBeenCalled();
    expect(mockCache.llm.store).not.toHaveBeenCalled();
  });

  it('middleware concatenates multiple text parts for caching', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.llm.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: false,
      tier: 'llm',
    } as LlmCacheResult);
    (mockCache.llm.store as ReturnType<typeof vi.fn>).mockResolvedValue('key');

    const middleware = createAgentCacheMiddleware({ cache: mockCache });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'Part one. ' },
        { type: 'text', text: 'Part two.' },
      ],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20 },
    });

    await middleware.wrapGenerate!({
      doGenerate,
      params: {
        model: { modelId: 'gpt-4o', provider: 'openai' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      },
    });

    expect(mockCache.llm.store).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
      'Part one. Part two.',
      { tokens: { input: 10, output: 20 } },
    );
  });
});

describe('LangGraph adapter', () => {
  let BetterDBSaver: typeof import('../adapters/langgraph').BetterDBSaver;

  beforeEach(async () => {
    const module = await import('../adapters/langgraph');
    BetterDBSaver = module.BetterDBSaver;
  });

  it('getTuple() returns undefined when no checkpoint exists', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.session.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const saver = new BetterDBSaver({ cache: mockCache });
    const result = await saver.getTuple({ configurable: { thread_id: 'thread-1' } });

    expect(result).toBeUndefined();
  });

  it('getTuple() returns parsed checkpoint tuple', async () => {
    const mockCache = createMockAgentCache();
    const tuple = {
      config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
      checkpoint: { id: 'cp-1', ts: '2024-01-01T00:00:00Z' },
      metadata: {},
    };
    (mockCache.session.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(tuple));
    (mockCache.session.scanFieldsByPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const saver = new BetterDBSaver({ cache: mockCache });
    const result = await saver.getTuple({ configurable: { thread_id: 'thread-1' } });

    expect(result).toEqual(tuple);
  });

  it('getTuple() uses scanFieldsByPrefix instead of getAll to avoid TTL side effects', async () => {
    const mockCache = createMockAgentCache();
    const tuple = {
      config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
      checkpoint: { id: 'cp-1', ts: '2024-01-01T00:00:00Z' },
      metadata: {},
    };
    (mockCache.session.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(tuple));
    (mockCache.session.scanFieldsByPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({
      'writes:cp-1|task-abc|messages|0': JSON.stringify({ role: 'assistant', content: 'Hi' }),
      'writes:cp-1|task-abc|state|1': JSON.stringify({ step: 2 }),
      'writes:cp-1|task-xyz|output|0': JSON.stringify('done'),
    });

    const saver = new BetterDBSaver({ cache: mockCache });
    const result = await saver.getTuple({ configurable: { thread_id: 'thread-1' } });

    expect(result).toBeDefined();
    expect(result!.pendingWrites).toBeDefined();
    expect(result!.pendingWrites).toHaveLength(3);

    // Verify scanFieldsByPrefix was called (not getAll)
    expect(mockCache.session.scanFieldsByPrefix).toHaveBeenCalledWith('thread-1', 'writes:cp-1|');
    expect(mockCache.session.getAll).not.toHaveBeenCalled();

    const sorted = [...result!.pendingWrites!].sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
    expect(sorted).toEqual([
      ['task-abc', 'messages', { role: 'assistant', content: 'Hi' }],
      ['task-abc', 'state', { step: 2 }],
      ['task-xyz', 'output', 'done'],
    ]);
  });

  it('getTuple() ignores writes for other checkpoints', async () => {
    const mockCache = createMockAgentCache();
    const tuple = {
      config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-2' } },
      checkpoint: { id: 'cp-2', ts: '2024-01-02T00:00:00Z' },
      metadata: {},
    };
    (mockCache.session.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(tuple));
    // scanFieldsByPrefix with cp-2 prefix returns nothing (the stale write is for cp-1)
    (mockCache.session.scanFieldsByPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const saver = new BetterDBSaver({ cache: mockCache });
    const result = await saver.getTuple({ configurable: { thread_id: 'thread-1' } });

    expect(result).toBeDefined();
    expect(result!.pendingWrites).toBeUndefined();
  });

  it('put() stores checkpoint and updates latest pointer', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.session.set as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const saver = new BetterDBSaver({ cache: mockCache });
    const checkpoint = { id: 'cp-1', ts: '2024-01-01T00:00:00Z' };

    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpoint as any,
      {},
      {},
    );

    expect(mockCache.session.set).toHaveBeenCalledWith(
      'thread-1',
      'checkpoint:cp-1',
      expect.any(String),
    );
    expect(mockCache.session.set).toHaveBeenCalledWith(
      'thread-1',
      'checkpoint:latest',
      expect.any(String),
    );
  });

  it('list() limit=1 fast path reads checkpoint:latest and uses scanFieldsByPrefix (not getAll)', async () => {
    const mockCache = createMockAgentCache();
    const latestTuple = {
      config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-3' } },
      checkpoint: { id: 'cp-3', ts: '2024-01-03T00:00:00Z' },
      metadata: {},
    };
    (mockCache.session.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(latestTuple));
    (mockCache.session.scanFieldsByPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({
      'writes:cp-3|task-1|output|0': JSON.stringify('fast-result'),
    });

    const saver = new BetterDBSaver({ cache: mockCache });
    const results: any[] = [];

    for await (const tuple of saver.list({ configurable: { thread_id: 'thread-1' } }, { limit: 1 })) {
      results.push(tuple);
    }

    expect(results.length).toBe(1);
    expect(results[0].checkpoint.id).toBe('cp-3');
    expect(results[0].pendingWrites).toEqual([['task-1', 'output', 'fast-result']]);

    expect(mockCache.session.get).toHaveBeenCalledWith('thread-1', 'checkpoint:latest');
    expect(mockCache.session.scanFieldsByPrefix).toHaveBeenCalledWith('thread-1', 'writes:cp-3|');
    expect(mockCache.session.getAll).not.toHaveBeenCalled();
  });

  it('list() returns checkpoints in reverse chronological order with pendingWrites', async () => {
    const mockCache = createMockAgentCache();
    const checkpoints = {
      'checkpoint:cp-1': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
        checkpoint: { id: 'cp-1', ts: '2024-01-01T00:00:00Z' },
        metadata: {},
      }),
      'checkpoint:cp-2': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-2' } },
        checkpoint: { id: 'cp-2', ts: '2024-01-02T00:00:00Z' },
        metadata: {},
      }),
      'checkpoint:latest': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-2' } },
        checkpoint: { id: 'cp-2', ts: '2024-01-02T00:00:00Z' },
        metadata: {},
      }),
      'writes:cp-2|task-1|output|0': JSON.stringify('result'),
    };
    (mockCache.session.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(checkpoints);

    const saver = new BetterDBSaver({ cache: mockCache });
    const results: any[] = [];

    for await (const tuple of saver.list({ configurable: { thread_id: 'thread-1' } })) {
      results.push(tuple);
    }

    expect(results.length).toBe(2);
    expect(results[0].checkpoint.id).toBe('cp-2'); // More recent first
    expect(results[0].pendingWrites).toEqual([['task-1', 'output', 'result']]);
    expect(results[1].checkpoint.id).toBe('cp-1');
    expect(results[1].pendingWrites).toBeUndefined();
  });

  it('list() respects limit option', async () => {
    const mockCache = createMockAgentCache();
    const checkpoints = {
      'checkpoint:cp-1': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
        checkpoint: { id: 'cp-1', ts: '2024-01-01T00:00:00Z' },
        metadata: {},
      }),
      'checkpoint:cp-2': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-2' } },
        checkpoint: { id: 'cp-2', ts: '2024-01-02T00:00:00Z' },
        metadata: {},
      }),
      'checkpoint:cp-3': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-3' } },
        checkpoint: { id: 'cp-3', ts: '2024-01-03T00:00:00Z' },
        metadata: {},
      }),
    };
    (mockCache.session.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(checkpoints);

    const saver = new BetterDBSaver({ cache: mockCache });
    const results: any[] = [];

    for await (const tuple of saver.list({ configurable: { thread_id: 'thread-1' } }, { limit: 2 })) {
      results.push(tuple);
    }

    expect(results.length).toBe(2);
  });

  it('list() respects before filter to start after specific checkpoint', async () => {
    const mockCache = createMockAgentCache();
    const checkpoints = {
      'checkpoint:cp-1': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
        checkpoint: { id: 'cp-1', ts: '2024-01-01T00:00:00Z' },
        metadata: {},
      }),
      'checkpoint:cp-2': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-2' } },
        checkpoint: { id: 'cp-2', ts: '2024-01-02T00:00:00Z' },
        metadata: {},
      }),
      'checkpoint:cp-3': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-3' } },
        checkpoint: { id: 'cp-3', ts: '2024-01-03T00:00:00Z' },
        metadata: {},
      }),
    };
    (mockCache.session.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(checkpoints);

    const saver = new BetterDBSaver({ cache: mockCache });
    const results: any[] = [];

    // Request checkpoints BEFORE cp-2 (should return cp-1 only, skipping cp-3 and cp-2)
    for await (const tuple of saver.list(
      { configurable: { thread_id: 'thread-1' } },
      { before: { configurable: { checkpoint_id: 'cp-2' } } }
    )) {
      results.push(tuple);
    }

    expect(results.length).toBe(1);
    expect(results[0].checkpoint.id).toBe('cp-1');
  });

  it('list() with non-existent before checkpoint yields zero results', async () => {
    const mockCache = createMockAgentCache();
    const checkpoints = {
      'checkpoint:cp-1': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
        checkpoint: { id: 'cp-1', ts: '2024-01-01T00:00:00Z' },
        metadata: {},
      }),
      'checkpoint:cp-2': JSON.stringify({
        config: { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-2' } },
        checkpoint: { id: 'cp-2', ts: '2024-01-02T00:00:00Z' },
        metadata: {},
      }),
    };
    (mockCache.session.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(checkpoints);

    const saver = new BetterDBSaver({ cache: mockCache });
    const results: any[] = [];

    for await (const tuple of saver.list(
      { configurable: { thread_id: 'thread-1' } },
      { before: { configurable: { checkpoint_id: 'non-existent-id' } } }
    )) {
      results.push(tuple);
    }

    expect(results.length).toBe(0);
  });

  it('putWrites() stores writes with taskId in key for deduplication', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.session.set as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const saver = new BetterDBSaver({ cache: mockCache });
    const writes: [string, unknown][] = [
      ['messages', { role: 'user', content: 'Hello' }],
      ['state', { step: 1 }],
    ];

    await saver.putWrites(
      { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
      writes,
      'task-abc',
    );

    // Verify taskId is included in the storage key (using | delimiter)
    expect(mockCache.session.set).toHaveBeenCalledWith(
      'thread-1',
      'writes:cp-1|task-abc|messages|0',
      JSON.stringify({ role: 'user', content: 'Hello' }),
    );
    expect(mockCache.session.set).toHaveBeenCalledWith(
      'thread-1',
      'writes:cp-1|task-abc|state|1',
      JSON.stringify({ step: 1 }),
    );
  });

  it('putWrites() handles empty writes array', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.session.set as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const saver = new BetterDBSaver({ cache: mockCache });

    await saver.putWrites(
      { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
      [],
      'task-abc',
    );

    expect(mockCache.session.set).not.toHaveBeenCalled();
  });

  it('putWrites() with different taskIds stores separately', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.session.set as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const saver = new BetterDBSaver({ cache: mockCache });

    await saver.putWrites(
      { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
      [['channel', 'value1']],
      'task-1',
    );
    await saver.putWrites(
      { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1' } },
      [['channel', 'value2']],
      'task-2',
    );

    // Different taskIds should result in different keys (using | delimiter)
    expect(mockCache.session.set).toHaveBeenCalledWith(
      'thread-1',
      'writes:cp-1|task-1|channel|0',
      JSON.stringify('value1'),
    );
    expect(mockCache.session.set).toHaveBeenCalledWith(
      'thread-1',
      'writes:cp-1|task-2|channel|0',
      JSON.stringify('value2'),
    );
  });

  it('putWrites() throws AgentCacheUsageError when checkpoint_id is missing', async () => {
    const mockCache = createMockAgentCache();
    const saver = new BetterDBSaver({ cache: mockCache });

    await expect(
      saver.putWrites(
        { configurable: { thread_id: 'thread-1' } },
        [['channel', 'value']],
        'task-1',
      ),
    ).rejects.toThrow('putWrites() requires both config.configurable.thread_id and config.configurable.checkpoint_id');
  });

  it('putWrites() throws AgentCacheUsageError when thread_id is missing', async () => {
    const mockCache = createMockAgentCache();
    const saver = new BetterDBSaver({ cache: mockCache });

    await expect(
      saver.putWrites(
        { configurable: { checkpoint_id: 'cp-1' } },
        [['channel', 'value']],
        'task-1',
      ),
    ).rejects.toThrow('putWrites() requires both config.configurable.thread_id and config.configurable.checkpoint_id');
  });

  it('put() throws AgentCacheUsageError when thread_id is missing', async () => {
    const mockCache = createMockAgentCache();
    const saver = new BetterDBSaver({ cache: mockCache });

    await expect(
      saver.put(
        { configurable: {} },
        { id: 'cp-1', ts: '2024-01-01T00:00:00Z' } as any,
        {},
        {},
      ),
    ).rejects.toThrow('put() requires config.configurable.thread_id');
  });

  it('deleteThread() calls session.destroyThread', async () => {
    const mockCache = createMockAgentCache();
    (mockCache.session.destroyThread as ReturnType<typeof vi.fn>).mockResolvedValue(5);

    const saver = new BetterDBSaver({ cache: mockCache });
    await saver.deleteThread('thread-1');

    expect(mockCache.session.destroyThread).toHaveBeenCalledWith('thread-1');
  });
});
