import { describe, it, expect, vi } from 'vitest';
import { createKeywordOverlapRerank } from '../rerank';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

// -- compare="prompt" (default) --

describe('createKeywordOverlapRerank', () => {
  it('compare="prompt": picks candidate whose stored prompt matches the query entity', async () => {
    const rerank = createKeywordOverlapRerank();
    const candidates = [
      { prompt: 'what is the weather in paris', response: 'Sunny, 25C', similarity: 0.05 },
      { prompt: 'what is the weather in berlin', response: 'Cloudy, 18C', similarity: 0.05 },
    ];
    expect(await rerank('what is the weather in berlin', candidates)).toBe(1);
  });

  it('default compare is "prompt" when omitted', async () => {
    const rerankDefault = createKeywordOverlapRerank();
    const rerankExplicit = createKeywordOverlapRerank({ compare: 'prompt' });
    const candidates = [
      { prompt: 'what is the weather in paris', response: 'weather in berlin', similarity: 0.05 },
      { prompt: 'what is the weather in berlin', response: 'weather in paris', similarity: 0.05 },
    ];
    const query = 'what is the weather in berlin';
    expect(await rerankDefault(query, candidates)).toBe(await rerankExplicit(query, candidates));
  });

  // -- compare="response" --

  it('compare="response": selection follows response overlap', async () => {
    const rerank = createKeywordOverlapRerank({ compare: 'response' });
    const candidates = [
      { prompt: 'what is the weather in berlin', response: 'Sunny in paris', similarity: 0.05 },
      { prompt: 'what is the weather in paris', response: 'Cloudy in berlin', similarity: 0.05 },
    ];
    expect(await rerank('weather in berlin', candidates)).toBe(1);
  });

  // -- cosineWeight extremes --

  it('cosineWeight=1.0 reduces to pure cosine (overlap ignored)', async () => {
    const rerank = createKeywordOverlapRerank({ cosineWeight: 1.0 });
    const candidates = [
      { prompt: 'completely different text', response: '', similarity: 0.01 },
      { prompt: 'what is the weather in berlin', response: '', similarity: 0.5 },
    ];
    expect(await rerank('what is the weather in berlin', candidates)).toBe(0);
  });

  it('cosineWeight=0.0 reduces to pure overlap', async () => {
    const rerank = createKeywordOverlapRerank({ cosineWeight: 0.0 });
    const candidates = [
      { prompt: 'completely different text', response: '', similarity: 0.01 },
      { prompt: 'what is the weather in berlin', response: '', similarity: 0.99 },
    ];
    expect(await rerank('what is the weather in berlin', candidates)).toBe(1);
  });

  // -- edge cases --

  it('empty query -> overlap contributes 0, falls back to cosine', async () => {
    const rerank = createKeywordOverlapRerank();
    const candidates = [
      { prompt: 'hello world', response: 'hi', similarity: 0.3 },
      { prompt: 'foo bar', response: 'baz', similarity: 0.1 },
    ];
    expect(await rerank('', candidates)).toBe(1);
  });

  it('missing/empty prompt on candidate -> treated as empty, no crash', async () => {
    const rerank = createKeywordOverlapRerank();
    const candidates = [
      { response: 'some response', similarity: 0.05, prompt: '' },
      { response: 'other', similarity: 0.05, prompt: '' },
      { prompt: 'what is the weather in berlin', response: '', similarity: 0.05 },
    ];
    expect(await rerank('what is the weather in berlin', candidates)).toBe(2);
  });

  it('cosineWeight outside [0, 1] throws', () => {
    expect(() => createKeywordOverlapRerank({ cosineWeight: 1.5 })).toThrow('cosineWeight must be in [0, 1]');
    expect(() => createKeywordOverlapRerank({ cosineWeight: -0.1 })).toThrow('cosineWeight must be in [0, 1]');
  });
});

// -- Phase 1 contract: candidate dicts include prompt --

describe('candidate prompt key contract', () => {
  it('candidates passed to rerankFn include a prompt key', async () => {
    let captured: Array<{ response: string; similarity: number; prompt: string }> | null = null;

    const mockClient = {
      call: vi.fn(async (...args: unknown[]) => {
        const cmd = args[0] as string;
        if (cmd === 'FT.INFO') {
          return ['attributes', [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']]]];
        }
        if (cmd === 'FT.SEARCH') {
          return [
            '1',
            'entry:1',
            ['prompt', 'stored prompt text', 'response', 'cached resp', 'model', '', 'category', '', '__score', '0.01'],
          ];
        }
        return null;
      }),
      hset: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      hincrby: vi.fn(async () => 1),
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
      pipeline: vi.fn(() => {
        const p = {
          hincrby: vi.fn().mockReturnThis(),
          zadd: vi.fn().mockReturnThis(),
          zremrangebyscore: vi.fn().mockReturnThis(),
          zremrangebyrank: vi.fn().mockReturnThis(),
          exec: vi.fn(async () => []),
        } as Record<string, unknown>;
        return p;
      }),
    };

    const cache = new SemanticCache({
      client: mockClient as unknown as Valkey,
      embedFn: async () => [0.1, 0.2],
      name: 'test_prompt_key',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    await cache.check('incoming query', {
      rerank: {
        k: 3,
        rerankFn: async (_query, candidates) => {
          captured = candidates;
          return 0;
        },
      },
    });

    expect(captured).not.toBeNull();
    expect(captured!.length).toBeGreaterThanOrEqual(1);
    expect(captured![0].prompt).toBe('stored prompt text');
    expect(captured![0].response).toBe('cached resp');
    expect(typeof captured![0].similarity).toBe('number');
  });
});
