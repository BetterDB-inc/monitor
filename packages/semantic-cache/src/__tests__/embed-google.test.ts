import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleEmbed } from '../embed/google';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      captured.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => {
          return { embedding: { values: [0.1, 0.2, 0.3] } };
        },
      };
    }),
  );
  return captured;
}

describe('createGoogleEmbed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to a model Google still serves', async () => {
    const captured = stubFetch();
    await createGoogleEmbed({ apiKey: 'k' })('hello');

    // text-embedding-004 and embedding-001 were shut down (2026-01-14 and
    // 2025-10-30); a default naming either resolves to a 404 at runtime.
    expect(captured[0].body.model).toBe('models/gemini-embedding-2');
    expect(captured[0].url).toContain('gemini-embedding-2:embedContent');
  });

  it('requests 768 dimensions by default so existing indexes stay compatible', async () => {
    const captured = stubFetch();
    await createGoogleEmbed({ apiKey: 'k' })('hello');

    // gemini-embedding-2 returns 3072 dimensions unless told otherwise, which
    // would not match a vector index built by earlier versions of this provider.
    expect(captured[0].body.outputDimensionality).toBe(768);
  });

  it('honours an explicit dimensionality override', async () => {
    const captured = stubFetch();
    await createGoogleEmbed({ apiKey: 'k', outputDimensionality: 3072 })('hello');

    expect(captured[0].body.outputDimensionality).toBe(3072);
  });

  it('honours an explicit model override', async () => {
    const captured = stubFetch();
    await createGoogleEmbed({ apiKey: 'k', model: 'gemini-embedding-001' })('hello');

    expect(captured[0].body.model).toBe('models/gemini-embedding-001');
  });
});
