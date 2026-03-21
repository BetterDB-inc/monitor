import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- LangChain adapter tests ----------

describe('BetterDBSemanticCache (LangChain adapter)', () => {
  const mockCache = {
    initialize: vi.fn().mockResolvedValue(undefined),
    check: vi.fn(),
    store: vi.fn().mockResolvedValue('key:1'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Lazy import to avoid hard dependency on @langchain/core in test runner
  async function createAdapter(opts?: { filterByModel?: boolean }) {
    const { BetterDBSemanticCache } = await import('../adapters/langchain');
    return new BetterDBSemanticCache({
      cache: mockCache as any,
      ...opts,
    });
  }

  it('lookup() returns null on cache miss', async () => {
    mockCache.check.mockResolvedValueOnce({ hit: false, confidence: 'miss' });
    const adapter = await createAdapter();
    const result = await adapter.lookup('What is AI?', 'model-hash');
    expect(result).toBeNull();
  });

  it('lookup() returns [{ text }] on cache hit', async () => {
    mockCache.check.mockResolvedValueOnce({
      hit: true,
      response: 'Artificial intelligence is...',
      confidence: 'high',
    });
    const adapter = await createAdapter();
    const result = await adapter.lookup('What is AI?', 'model-hash');
    expect(result).toEqual([{ text: 'Artificial intelligence is...' }]);
  });

  it('update() calls cache.store() with joined generation text', async () => {
    const adapter = await createAdapter();
    await adapter.update('What is AI?', 'model-hash', [
      { text: 'Part 1. ' },
      { text: 'Part 2.' },
    ]);
    const expectedHash = createHash('sha256').update('model-hash').digest('hex').slice(0, 16);
    expect(mockCache.store).toHaveBeenCalledWith('What is AI?', 'Part 1. Part 2.', {
      model: expectedHash,
    });
  });

  it('initialize() is called lazily on first lookup(), not in constructor', async () => {
    const adapter = await createAdapter();
    expect(mockCache.initialize).not.toHaveBeenCalled();
    mockCache.check.mockResolvedValueOnce({ hit: false, confidence: 'miss' });
    await adapter.lookup('test', 'hash');
    expect(mockCache.initialize).toHaveBeenCalledTimes(1);
  });

  it('initialize() is called only once across multiple calls', async () => {
    const adapter = await createAdapter();
    mockCache.check.mockResolvedValue({ hit: false, confidence: 'miss' });
    await adapter.lookup('a', 'h');
    await adapter.lookup('b', 'h');
    await adapter.update('c', 'h', [{ text: 'response' }]);
    expect(mockCache.initialize).toHaveBeenCalledTimes(1);
  });
});

// ---------- Vercel AI SDK middleware tests ----------

describe('createSemanticCacheMiddleware (AI SDK adapter)', () => {
  const mockCache = {
    initialize: vi.fn().mockResolvedValue(undefined),
    check: vi.fn(),
    store: vi.fn().mockResolvedValue('key:1'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function createMiddleware() {
    const { createSemanticCacheMiddleware } = await import('../adapters/ai');
    return createSemanticCacheMiddleware({ cache: mockCache as any });
  }

  function makeParams(userText: string) {
    return {
      prompt: [
        { role: 'user', content: [{ type: 'text', text: userText }] },
      ],
    };
  }

  const modelResult = {
    content: [{ type: 'text', text: 'Model response' }],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5 },
    warnings: [],
  };

  it('on cache hit, doGenerate is not called', async () => {
    mockCache.check.mockResolvedValueOnce({
      hit: true,
      response: 'Cached response',
      confidence: 'high',
      matchedKey: 'key:1',
    });
    const middleware = await createMiddleware();
    const doGenerate = vi.fn();
    const doStream = vi.fn();

    const result = await middleware.wrapGenerate!({
      doGenerate,
      doStream,
      params: makeParams('Hello') as any,
      model: {} as any,
    });

    expect(doGenerate).not.toHaveBeenCalled();
    expect((result as any).content[0].text).toBe('Cached response');
    expect((result as any).finishReason).toBe('stop');
  });

  it('on cache miss, doGenerate is called and result is stored', async () => {
    mockCache.check.mockResolvedValueOnce({ hit: false, confidence: 'miss' });
    const middleware = await createMiddleware();
    const doGenerate = vi.fn().mockResolvedValue(modelResult);
    const doStream = vi.fn();

    const result = await middleware.wrapGenerate!({
      doGenerate,
      doStream,
      params: makeParams('Hello') as any,
      model: {} as any,
    });

    expect(doGenerate).toHaveBeenCalledTimes(1);
    expect(mockCache.store).toHaveBeenCalledWith('Hello', 'Model response');
    expect(result).toBe(modelResult);
  });

  it('initialize() is called lazily on first invocation', async () => {
    mockCache.check.mockResolvedValue({ hit: false, confidence: 'miss' });
    const middleware = await createMiddleware();
    expect(mockCache.initialize).not.toHaveBeenCalled();

    const doGenerate = vi.fn().mockResolvedValue(modelResult);
    const doStream = vi.fn();
    await middleware.wrapGenerate!({
      doGenerate,
      doStream,
      params: makeParams('test') as any,
      model: {} as any,
    });
    expect(mockCache.initialize).toHaveBeenCalledTimes(1);

    // Second call should not re-initialize
    await middleware.wrapGenerate!({
      doGenerate,
      doStream,
      params: makeParams('test2') as any,
      model: {} as any,
    });
    expect(mockCache.initialize).toHaveBeenCalledTimes(1);
  });
});
