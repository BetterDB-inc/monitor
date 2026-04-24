import { describe, it, expect, vi } from 'vitest';
import { prepareSemanticParams } from '../../adapters/llamaindex';
import type { ChatMessage } from '@llamaindex/core/llms';

function userMsg(content: string): ChatMessage {
  return { role: 'user', content };
}
function assistantMsg(content: string): ChatMessage {
  return { role: 'assistant', content };
}

describe('prepareSemanticParams (llamaindex)', () => {
  it('extracts last user message text', async () => {
    const messages: ChatMessage[] = [
      userMsg('What is the capital of France?'),
    ];
    const result = await prepareSemanticParams(messages, { model: 'gpt-4o' });
    expect(result.text).toBe('What is the capital of France?');
    expect(result.model).toBe('gpt-4o');
  });

  it('picks last user message in multi-turn', async () => {
    const messages: ChatMessage[] = [
      userMsg('First'),
      assistantMsg('Answer'),
      userMsg('Second question'),
    ];
    const result = await prepareSemanticParams(messages, { model: 'gpt-4o' });
    expect(result.text).toBe('Second question');
  });

  it('returns empty text when no user messages', async () => {
    const messages: ChatMessage[] = [assistantMsg('Only assistant')];
    const result = await prepareSemanticParams(messages);
    expect(result.text).toBe('');
  });

  it('handles array content', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'world' },
        ],
      },
    ] as unknown as ChatMessage[];
    const result = await prepareSemanticParams(messages, { model: 'gpt-4o' });
    expect(result.text).toBe('Hello world');
  });

  it('extracts image_url as BinaryBlock', async () => {
    const normalizer = vi.fn(async () => 'sha256:img');
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
        ],
      },
    ] as unknown as ChatMessage[];
    const result = await prepareSemanticParams(messages, { model: 'gpt-4o', normalizer });
    expect(result.blocks?.some((b) => b.type === 'binary')).toBe(true);
  });

  it('model is undefined when not provided', async () => {
    const result = await prepareSemanticParams([userMsg('Hello')]);
    expect(result.model).toBeUndefined();
  });
});
