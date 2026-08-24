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

  it('leaves dimensionality to the model when it is not gemini-embedding-2', async () => {
    const captured = stubFetch();
    await createGoogleEmbed({ apiKey: 'k', model: 'gemini-embedding-001' })('hello');

    // The 768 default exists to keep gemini-embedding-2 compatible with an
    // existing index. Applying it here would silently truncate a caller who
    // was getting this model's native 3072 and break their index.
    expect(captured[0].body).not.toHaveProperty('outputDimensionality');
  });

  it('honours an explicit dimensionality override on any model', async () => {
    const captured = stubFetch();
    await createGoogleEmbed({
      apiKey: 'k',
      model: 'gemini-embedding-001',
      outputDimensionality: 1536,
    })('hello');

    expect(captured[0].body.outputDimensionality).toBe(1536);
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

  describe('task handling', () => {
    it('never sends taskType to gemini-embedding-2', async () => {
      const captured = stubFetch();
      await createGoogleEmbed({ apiKey: 'k' })('hello');

      // The API rejects task_type for this model; the task rides in the text.
      expect(captured[0].body).not.toHaveProperty('taskType');
      expect(captured[0].body).not.toHaveProperty('title');
    });

    it('carries the task as a text prefix for gemini-embedding-2', async () => {
      const captured = stubFetch();
      await createGoogleEmbed({ apiKey: 'k' })('hello');

      const content = captured[0].body.content as { parts: { text: string }[] };
      expect(content.parts[0].text).toBe('task: search result | query: hello');
    });

    it('uses the document format when storing with gemini-embedding-2', async () => {
      const captured = stubFetch();
      await createGoogleEmbed({
        apiKey: 'k',
        taskType: 'RETRIEVAL_DOCUMENT',
        title: 'Capitals',
      })('Paris');

      const content = captured[0].body.content as { parts: { text: string }[] };
      expect(content.parts[0].text).toBe('title: Capitals | text: Paris');
    });

    it('falls back to a none title for untitled documents', async () => {
      const captured = stubFetch();
      await createGoogleEmbed({ apiKey: 'k', taskType: 'RETRIEVAL_DOCUMENT' })('Paris');

      const content = captured[0].body.content as { parts: { text: string }[] };
      expect(content.parts[0].text).toBe('title: none | text: Paris');
    });

    it('passes unknown task types through without a prefix', async () => {
      const captured = stubFetch();
      await createGoogleEmbed({ apiKey: 'k', taskType: 'SOMETHING_NEW' })('hello');

      const content = captured[0].body.content as { parts: { text: string }[] };
      expect(content.parts[0].text).toBe('hello');
    });

    it('still sends taskType and title as fields for gemini-embedding-001', async () => {
      const captured = stubFetch();
      await createGoogleEmbed({
        apiKey: 'k',
        model: 'gemini-embedding-001',
        taskType: 'RETRIEVAL_DOCUMENT',
        title: 'Capitals',
      })('Paris');

      expect(captured[0].body.taskType).toBe('RETRIEVAL_DOCUMENT');
      expect(captured[0].body.title).toBe('Capitals');

      const content = captured[0].body.content as { parts: { text: string }[] };
      expect(content.parts[0].text).toBe('Paris');
    });
  });
});
