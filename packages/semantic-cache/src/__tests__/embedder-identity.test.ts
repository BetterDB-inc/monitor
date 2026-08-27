import { describe, expect, it } from 'vitest';

import { describeEmbedder, embedderFingerprint, getEmbedderDescriptor } from '../embedder-identity';
import type { EmbedderDescriptor, EmbedFn } from '../types';

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

  it('snapshots the descriptor so a later mutation cannot rewrite the identity', () => {
    const descriptor: EmbedderDescriptor = {
      provider: 'openai',
      model: 'small',
      params: { inputType: 'query' },
    };
    const described = describeEmbedder(plainEmbed(), descriptor);

    descriptor.model = 'large';
    if (descriptor.params !== undefined) {
      descriptor.params.inputType = 'document';
    }

    expect(described.descriptor).toEqual({
      provider: 'openai',
      model: 'small',
      params: { inputType: 'query' },
    });
  });

  it('does not let a caller mutate the attached descriptor', () => {
    const described = describeEmbedder(plainEmbed(), {
      provider: 'openai',
      model: 'small',
      params: { inputType: 'query' },
    });

    expect(() => {
      (described.descriptor as EmbedderDescriptor).model = 'large';
    }).toThrow(TypeError);
    expect(described.descriptor.model).toBe('small');
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

  it('separates params whose values contain the separators it renders with', () => {
    const packed = embedderFingerprint({
      provider: 'voyage',
      model: 'voyage-3-lite',
      params: { inputType: 'query&outputDimensionality=256' },
    });
    const split = embedderFingerprint({
      provider: 'voyage',
      model: 'voyage-3-lite',
      params: { inputType: 'query', outputDimensionality: 256 },
    });

    expect(packed).not.toBe(split);
  });

  it('separates a model whose name carries the param separator', () => {
    const tagged = embedderFingerprint({ provider: 'ollama', model: 'nomic-embed-text#a=1' });
    const paramed = embedderFingerprint({
      provider: 'ollama',
      model: 'nomic-embed-text',
      params: { a: 1 },
    });

    expect(tagged).not.toBe(paramed);
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
