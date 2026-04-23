import { describe, it, expect, vi } from 'vitest';
import { prepareSemanticParams } from '../../adapters/anthropic';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources';

function makeParams(overrides: Partial<MessageCreateParamsNonStreaming> = {}): MessageCreateParamsNonStreaming {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'What is the capital of France?' },
    ],
    ...overrides,
  } as MessageCreateParamsNonStreaming;
}

describe('prepareSemanticParams (anthropic)', () => {
  it('extracts last user message text', async () => {
    const result = await prepareSemanticParams(makeParams());
    expect(result.text).toBe('What is the capital of France?');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('picks last user message in multi-turn', async () => {
    const params = makeParams({
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'Second question' },
      ],
    });
    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('Second question');
  });

  it('returns empty text when no user messages', async () => {
    const params = makeParams({ messages: [] });
    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('');
  });

  it('handles array content with text blocks', async () => {
    const params = makeParams({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'world' },
          ],
        },
      ],
    });
    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('Hello world');
    expect(result.blocks?.length).toBe(2);
  });

  it('extracts image block as BinaryBlock', async () => {
    const normalizer = vi.fn(async () => 'sha256:imagehash');
    const params = makeParams({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
            },
          ],
        },
      ],
    });
    const result = await prepareSemanticParams(params as MessageCreateParamsNonStreaming, { normalizer });
    expect(result.text).toBe('Describe this image');
    expect(result.blocks?.length).toBe(2);
    const bin = result.blocks?.find((b) => b.type === 'binary');
    expect(bin).toBeDefined();
    if (bin?.type === 'binary') {
      expect(bin.ref).toBe('sha256:imagehash');
      expect(bin.mediaType).toBe('image/png');
    }
  });

  it('extracts model correctly', async () => {
    const result = await prepareSemanticParams(
      makeParams({ model: 'claude-opus-4-6' }),
    );
    expect(result.model).toBe('claude-opus-4-6');
  });
});
