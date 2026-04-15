import { describe, it, expect } from 'vitest';
import { sha256, canonicalJson, llmCacheHash, toolCacheHash } from '../utils';

describe('sha256', () => {
  it('produces consistent hex output', () => {
    const input = 'hello world';
    const hash1 = sha256(input);
    const hash2 = sha256(input);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different output for different inputs', () => {
    const hash1 = sha256('hello');
    const hash2 = sha256('world');

    expect(hash1).not.toBe(hash2);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at all nesting levels', () => {
    const obj = { z: 1, a: { y: 2, b: 3 } };
    const result = canonicalJson(obj);
    const parsed = JSON.parse(result);

    expect(Object.keys(parsed)).toEqual(['a', 'z']);
    expect(Object.keys(parsed.a)).toEqual(['b', 'y']);
  });

  it('preserves array order', () => {
    const obj = { arr: [3, 1, 2] };
    const result = canonicalJson(obj);
    const parsed = JSON.parse(result);

    expect(parsed.arr).toEqual([3, 1, 2]);
  });

  it('handles nested arrays in objects', () => {
    const obj = { b: [{ z: 1, a: 2 }], a: 3 };
    const result = canonicalJson(obj);
    const parsed = JSON.parse(result);

    expect(Object.keys(parsed)).toEqual(['a', 'b']);
    expect(Object.keys(parsed.b[0])).toEqual(['a', 'z']);
  });

  it('handles null values', () => {
    const obj = { a: null, b: 1 };
    const result = canonicalJson(obj);

    expect(result).toBe('{"a":null,"b":1}');
  });
});

describe('llmCacheHash', () => {
  it('produces same hash regardless of tool order', () => {
    const tools1 = [
      { type: 'function', function: { name: 'get_weather', description: 'Get weather' } },
      { type: 'function', function: { name: 'search', description: 'Search web' } },
    ];
    const tools2 = [
      { type: 'function', function: { name: 'search', description: 'Search web' } },
      { type: 'function', function: { name: 'get_weather', description: 'Get weather' } },
    ];

    const hash1 = llmCacheHash({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: tools1,
    });
    const hash2 = llmCacheHash({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: tools2,
    });

    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different temperatures', () => {
    const hash1 = llmCacheHash({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0,
    });
    const hash2 = llmCacheHash({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.5,
    });

    expect(hash1).not.toBe(hash2);
  });

  it('uses default temperature=1 when omitted', () => {
    const hash1 = llmCacheHash({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const hash2 = llmCacheHash({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 1,
    });

    expect(hash1).toBe(hash2);
  });

  it('uses default top_p=1 when omitted', () => {
    const hash1 = llmCacheHash({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const hash2 = llmCacheHash({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      top_p: 1,
    });

    expect(hash1).toBe(hash2);
  });
});

describe('toolCacheHash', () => {
  it('produces same hash regardless of arg key order', () => {
    const hash1 = toolCacheHash({ city: 'Sofia', units: 'metric' });
    const hash2 = toolCacheHash({ units: 'metric', city: 'Sofia' });

    expect(hash1).toBe(hash2);
  });

  it('handles nested objects', () => {
    const hash1 = toolCacheHash({
      location: { city: 'Sofia', country: 'BG' },
      units: 'metric',
    });
    const hash2 = toolCacheHash({
      units: 'metric',
      location: { country: 'BG', city: 'Sofia' },
    });

    expect(hash1).toBe(hash2);
  });

  it('handles null args', () => {
    const hash = toolCacheHash(null);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles undefined args', () => {
    const hash = toolCacheHash(undefined);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('null and undefined produce same hash', () => {
    const hash1 = toolCacheHash(null);
    const hash2 = toolCacheHash(undefined);

    expect(hash1).toBe(hash2);
  });

  it('empty object and null/undefined produce same hash', () => {
    const hash1 = toolCacheHash({});
    const hash2 = toolCacheHash(null);

    expect(hash1).toBe(hash2);
  });
});
