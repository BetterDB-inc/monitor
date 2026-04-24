import { describe, it, expect, vi } from 'vitest';
import { extractText, extractBinaryRefs } from '../utils';
import { hashBase64, composeNormalizer } from '../normalizer';
import type { ContentBlock, TextBlock, BinaryBlock } from '../utils';

// --- extractText tests ---

describe('extractText', () => {
  it('extracts text from TextBlock[]', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'world' },
    ];
    expect(extractText(blocks)).toBe('Hello world');
  });

  it('ignores non-text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'binary', kind: 'image', mediaType: 'image/png', ref: 'sha256:abc' },
      { type: 'text', text: 'world' },
    ];
    expect(extractText(blocks)).toBe('Hello world');
  });

  it('returns empty string for empty blocks', () => {
    expect(extractText([])).toBe('');
  });

  it('returns empty string for blocks with no text', () => {
    const blocks: ContentBlock[] = [
      { type: 'binary', kind: 'image', mediaType: 'image/png', ref: 'sha256:abc' },
    ];
    expect(extractText(blocks)).toBe('');
  });
});

// --- extractBinaryRefs tests ---

describe('extractBinaryRefs', () => {
  it('extracts refs from BinaryBlocks sorted', () => {
    const blocks: ContentBlock[] = [
      { type: 'binary', kind: 'image', mediaType: 'image/png', ref: 'sha256:bbb' },
      { type: 'text', text: 'some text' },
      { type: 'binary', kind: 'image', mediaType: 'image/jpeg', ref: 'sha256:aaa' },
    ];
    expect(extractBinaryRefs(blocks)).toEqual(['sha256:aaa', 'sha256:bbb']);
  });

  it('returns empty array for text-only blocks', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }];
    expect(extractBinaryRefs(blocks)).toEqual([]);
  });
});

// --- hashBase64 tests ---

describe('hashBase64', () => {
  it('produces consistent hashes for same input', () => {
    const data = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64
    expect(hashBase64(data)).toBe(hashBase64(data));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashBase64('abc')).not.toBe(hashBase64('def'));
  });

  it('strips data URL prefix', () => {
    const withPrefix = 'data:image/png;base64,SGVsbG8=';
    const withoutPrefix = 'SGVsbG8=';
    expect(hashBase64(withPrefix)).toBe(hashBase64(withoutPrefix));
  });

  it('returns sha256: prefixed string', () => {
    expect(hashBase64('SGVsbG8=')).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// --- composeNormalizer tests ---

describe('composeNormalizer', () => {
  it('uses base64 handler when source is base64', async () => {
    const customHash = vi.fn((data: string) => `custom:${data}`);
    const normalizer = composeNormalizer({ base64: customHash });
    const ref = await normalizer({ kind: 'image', source: { type: 'base64', data: 'SGVsbG8=' } });
    expect(ref).toBe('custom:SGVsbG8=');
    expect(customHash).toHaveBeenCalledWith('SGVsbG8=');
  });

  it('uses passthrough when no handler configured', async () => {
    const normalizer = composeNormalizer({});
    const ref = await normalizer({ kind: 'image', source: { type: 'base64', data: 'SGVsbG8=' } });
    expect(ref).toBe('base64:SGVsbG8=');
  });

  it('uses byKind handler over source handler', async () => {
    const imageHandler = vi.fn(async () => 'image-specific');
    const base64Handler = vi.fn(() => 'base64-specific');
    const normalizer = composeNormalizer({
      base64: base64Handler,
      byKind: { image: imageHandler },
    });
    const ref = await normalizer({ kind: 'image', source: { type: 'base64', data: 'abc' } });
    expect(ref).toBe('image-specific');
    expect(imageHandler).toHaveBeenCalled();
    expect(base64Handler).not.toHaveBeenCalled();
  });

  it('handles url source', async () => {
    const normalizer = composeNormalizer({ url: (url) => `hashed:${url}` });
    const ref = await normalizer({ kind: 'image', source: { type: 'url', url: 'https://example.com/img.png' } });
    expect(ref).toBe('hashed:https://example.com/img.png');
  });

  it('handles fileId source', async () => {
    const normalizer = composeNormalizer({
      fileId: (id, provider) => `${provider}:${id}`,
    });
    const ref = await normalizer({
      kind: 'image',
      source: { type: 'fileId', fileId: 'file-123', provider: 'openai' },
    });
    expect(ref).toBe('openai:file-123');
  });
});

// --- SemanticCache multimodal behavior tests ---
// Tests for storeMultipart and ContentBlock[] check/store

import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

function makeMockClientForMultimodal() {
  const hashStore = new Map<string, Record<string, string>>();
  let lastStoredFields: Record<string, string> = {};

  const mockClient = {
    hashStore,
    lastStoredFields: (): Record<string, string> => lastStoredFields,
    call: vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [
            ['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']],
            ['identifier', 'binary_refs'],
          ],
        ];
      }
      if (cmd === 'FT.CREATE') return 'OK';
      if (cmd === 'FT.SEARCH') {
        // Return first entry in hashStore
        const entries = [...hashStore.entries()];
        if (entries.length === 0) return ['0'];
        const [key, fields] = entries[0];
        return [
          '1',
          key,
          Object.entries(fields).flatMap(([k, v]) => [k, v]).concat(['__score', '0.01']),
        ];
      }
      if (cmd === 'FT.DROPINDEX') return 'OK';
      return null;
    }),
    hset: vi.fn(async (key: string, fields: Record<string, string | Buffer>) => {
      const strFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        strFields[k] = Buffer.isBuffer(v) ? '__buffer__' : String(v);
      }
      hashStore.set(key, strFields);
      lastStoredFields = strFields;
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => hashStore.get(key) ?? {}),
    hincrby: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    pipeline: vi.fn(() => ({
      hincrby: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => []),
      zadd: vi.fn().mockReturnThis(),
      zremrangebyscore: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
    })),
    zrange: vi.fn(async () => []),
    nodes: vi.fn(() => null),
  };

  return mockClient;
}

describe('storeMultipart', () => {
  it('stores content_blocks as JSON and response as text', async () => {
    const client = makeMockClientForMultimodal();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_mp',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const blocks: ContentBlock[] = [
      { type: 'text', text: 'The answer is 42' },
      { type: 'reasoning', text: 'I calculated this carefully' },
    ];

    await cache.storeMultipart('What is the answer?', blocks);

    const storedFields = client.lastStoredFields();
    expect(storedFields['response']).toBe('The answer is 42');
    expect(storedFields['content_blocks']).toBeDefined();
    const parsed = JSON.parse(storedFields['content_blocks']);
    expect(parsed).toEqual(blocks);
  });

  it('check() returns contentBlocks on hit when stored via storeMultipart', async () => {
    const client = makeMockClientForMultimodal();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const blocks: ContentBlock[] = [
      { type: 'text', text: 'The answer is 42' },
    ];

    // Pre-seed with a storeMultipart-style entry
    const entryKey = 'test_mp2:entry:abc';
    client.hashStore.set(entryKey, {
      response: 'The answer is 42',
      content_blocks: JSON.stringify(blocks),
      model: '',
      category: '',
    });

    client.call.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']]],
        ];
      }
      if (cmd === 'FT.SEARCH') {
        const fields = client.hashStore.get(entryKey) ?? {};
        return [
          '1',
          entryKey,
          Object.entries(fields).flatMap(([k, v]) => [k, v]).concat(['__score', '0.01']),
        ];
      }
      return null;
    });

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_mp2',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.check('What is the answer?');
    expect(result.hit).toBe(true);
    expect(result.response).toBe('The answer is 42');
    expect(result.contentBlocks).toEqual(blocks);
  });
});

describe('binary-aware caching', () => {
  it('text-only string input produces same behavior as v0.1 (no binary_refs field)', async () => {
    const client = makeMockClientForMultimodal();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_text_only',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    await cache.store('Hello world', 'Hi there');

    const storedFields = client.lastStoredFields();
    expect(storedFields['binary_refs']).toBeUndefined();
    expect(storedFields['prompt']).toBe('Hello world');
  });

  it('ContentBlock[] with only TextBlocks stores no binary_refs', async () => {
    const client = makeMockClientForMultimodal();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_text_blocks',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello world' },
    ];

    await cache.store(blocks, 'Hi there');

    const storedFields = client.lastStoredFields();
    expect(storedFields['binary_refs']).toBeUndefined();
    expect(storedFields['prompt']).toBe('Hello world');
  });

  it('ContentBlock[] with BinaryBlock stores binary_refs field', async () => {
    const client = makeMockClientForMultimodal();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_binary',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Look at this image' },
      { type: 'binary', kind: 'image', mediaType: 'image/png', ref: 'sha256:abc123' },
    ];

    await cache.store(blocks, 'A nice image');

    const storedFields = client.lastStoredFields();
    expect(storedFields['binary_refs']).toBeDefined();
    expect(storedFields['binary_refs']).toContain('sha256:abc123');
    expect(storedFields['prompt']).toBe('Look at this image');
  });
});
