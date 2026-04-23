import { describe, it, expect } from 'vitest';
import { prepareSemanticParams } from '../../adapters/openai-responses';
import type { ResponseCreateParams } from 'openai/resources/responses/responses';

describe('prepareSemanticParams (openai-responses)', () => {
  it('handles string input', async () => {
    const params = {
      model: 'gpt-4o',
      input: 'What is the capital of France?',
    } as unknown as ResponseCreateParams;

    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('What is the capital of France?');
    expect(result.model).toBe('gpt-4o');
  });

  it('falls back to instructions when no input', async () => {
    const params = {
      model: 'gpt-4o',
      instructions: 'You are a helpful assistant',
    } as unknown as ResponseCreateParams;

    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('You are a helpful assistant');
  });

  it('extracts last user message from array input', async () => {
    const params = {
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'First question' },
        { type: 'message', role: 'assistant', content: 'Answer' },
        { type: 'message', role: 'user', content: 'Second question' },
      ],
    } as unknown as ResponseCreateParams;

    const result = await prepareSemanticParams(params);
    // Should extract from last user message
    expect(result.text).toBeTruthy();
    expect(result.model).toBe('gpt-4o');
  });

  it('returns empty text with no input or instructions', async () => {
    const params = {
      model: 'gpt-4o',
    } as unknown as ResponseCreateParams;

    const result = await prepareSemanticParams(params);
    expect(result.text).toBe('');
  });

  it('extracts model correctly', async () => {
    const params = {
      model: 'gpt-4o-mini',
      input: 'Hello',
    } as unknown as ResponseCreateParams;

    const result = await prepareSemanticParams(params);
    expect(result.model).toBe('gpt-4o-mini');
  });
});
