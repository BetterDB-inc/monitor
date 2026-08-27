import { describe, expect, it } from 'vitest';

import { describeEmbedder, embedderFingerprint, getEmbedderDescriptor } from '../embedder-identity';
import type { EmbedFn } from '../types';

function plainEmbed(): EmbedFn {
  return async () => {
    return [1, 2, 3];
  };
}

describe('describeEmbedder', () => {
  it('exposes the descriptor on the returned function', () => {
    const described = describeEmbedder(plainEmbed(), { provider: 'openai', model: 'small' });

    expect(described.descriptor).toEqual({ provider: 'openai', model: 'small' });
  });

  it('returns the same function reference and leaves it callable', async () => {
    const fn = plainEmbed();
    const described = describeEmbedder(fn, { provider: 'openai', model: 'small' });

    expect(described).toBe(fn);
    await expect(described('hello')).resolves.toEqual([1, 2, 3]);
  });

  it('keeps the descriptor off the enumerable surface', () => {
    const described = describeEmbedder(plainEmbed(), { provider: 'openai', model: 'small' });

    expect(Object.keys(described)).not.toContain('descriptor');
  });
});

describe('embedderFingerprint', () => {
  it('renders provider and model when there are no params', () => {
    expect(embedderFingerprint({ provider: 'openai', model: 'text-embedding-3-small' })).toBe(
      'openai:text-embedding-3-small',
    );
  });

  it('is stable across param insertion order', () => {
    const a = embedderFingerprint({
      provider: 'google',
      model: 'gemini-embedding-2',
      params: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 },
    });
    const b = embedderFingerprint({
      provider: 'google',
      model: 'gemini-embedding-2',
      params: { outputDimensionality: 768, taskType: 'RETRIEVAL_QUERY' },
    });

    expect(a).toBe(b);
    expect(a).toBe('google:gemini-embedding-2#outputDimensionality=768&taskType=RETRIEVAL_QUERY');
  });

  it('treats absent, empty and all-undefined params alike', () => {
    const absent = embedderFingerprint({ provider: 'ollama', model: 'nomic-embed-text' });
    const empty = embedderFingerprint({
      provider: 'ollama',
      model: 'nomic-embed-text',
      params: {},
    });
    const undef = embedderFingerprint({
      provider: 'ollama',
      model: 'nomic-embed-text',
      params: { outputDimensionality: undefined },
    });

    expect(empty).toBe(absent);
    expect(undef).toBe(absent);
  });

  it('separates models that differ only by a space-affecting param', () => {
    const query = embedderFingerprint({
      provider: 'voyage',
      model: 'voyage-3-lite',
      params: { inputType: 'query' },
    });
    const document = embedderFingerprint({
      provider: 'voyage',
      model: 'voyage-3-lite',
      params: { inputType: 'document' },
    });

    expect(query).not.toBe(document);
  });
});

describe('getEmbedderDescriptor', () => {
  it('reads the descriptor back off a described embedder', () => {
    const described = describeEmbedder(plainEmbed(), { provider: 'cohere', model: 'v3' });

    expect(getEmbedderDescriptor(described)).toEqual({ provider: 'cohere', model: 'v3' });
  });

  it('returns undefined for a hand-rolled closure', () => {
    expect(getEmbedderDescriptor(plainEmbed())).toBeUndefined();
  });
});
