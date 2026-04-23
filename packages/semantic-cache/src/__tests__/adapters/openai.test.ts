import { describe, it, expect, vi } from 'vitest';
import { prepareSemanticParams } from '../../adapters/openai';
import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';

function makeParams(overrides: Partial<ChatCompletionCreateParams> = {}): ChatCompletionCreateParams {
  return {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'What is the capital of France?' },
    ],
    ...overrides,
  } as ChatCompletionCreateParams;
}

describe('prepareSemanticParams (openai)', () => {
  it('extracts last user message text', async () => {
    const result = await prepareSemanticParams(makeParams());
    expect(result.text).toBe('What is the capital of France?');
    expect(result.model).toBe('gpt-4o');
    expect(result.blocks).toBeUndefined();
  });

  it('extracts text from multi-turn: picks last user message', async () => {
    const params = makeParams({
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' },
      ],
    });
    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('Second question');
  });

  it('returns empty text when no user messages', async () => {
    const params = makeParams({
      messages: [{ role: 'system', content: 'System only' }],
    });
    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('');
    expect(result.model).toBe('gpt-4o');
  });

  it('handles array content with text parts', async () => {
    const params = makeParams({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
        } as unknown as (typeof params.messages)[0],
      ],
    });
    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('First part Second part');
    expect(result.blocks).toBeDefined();
    expect(result.blocks?.length).toBe(2);
  });

  it('extracts image_url as BinaryBlock', async () => {
    const normalizer = vi.fn(async () => 'sha256:imagehash');
    const params = makeParams({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
          ],
        } as unknown as (typeof params.messages)[0],
      ],
    });
    const result = await prepareSemanticParams(params, { normalizer });
    expect(result.text).toBe('What is in this image?');
    expect(result.blocks?.length).toBe(2);
    const imgBlock = result.blocks?.find((b) => b.type === 'binary');
    expect(imgBlock?.type).toBe('binary');
    if (imgBlock?.type === 'binary') {
      expect(imgBlock.ref).toBe('sha256:imagehash');
    }
  });

  it('extracts base64 image with media type', async () => {
    const normalizer = vi.fn(async (ref) => `hash:${ref.source.type}`);
    const params = makeParams({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,/9j/abc' },
            },
          ],
        } as unknown as (typeof params.messages)[0],
      ],
    });
    const result = await prepareSemanticParams(params, { normalizer });
    expect(result.blocks?.[0]?.type).toBe('binary');
    if (result.blocks?.[0]?.type === 'binary') {
      expect(result.blocks[0].mediaType).toBe('image/jpeg');
    }
  });
});
