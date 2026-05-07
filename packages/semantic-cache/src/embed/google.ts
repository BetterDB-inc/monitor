/**
 * Google AI (Gemini) embedding helper for @betterdb/semantic-cache.
 *
 * Supports text-embedding-004 and other Gemini embedding models via the
 * Google AI REST API. Uses native fetch - no SDK required.
 *
 * Usage:
 *   import { createGoogleEmbed } from '@betterdb/semantic-cache/embed/google';
 *   const embed = createGoogleEmbed({ model: 'text-embedding-004' });
 *   const cache = new SemanticCache({ client, embedFn: embed });
 */
import type { EmbedFn } from '../types';

export type GoogleEmbedTaskType =
  | 'RETRIEVAL_QUERY'
  | 'RETRIEVAL_DOCUMENT'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING'
  | (string & {});

export interface GoogleEmbedOptions {
  /**
   * Google AI embedding model.
   * Default: 'text-embedding-004' (768 dimensions).
   * Other options: 'text-multilingual-embedding-002', 'embedding-001'.
   */
  model?: string;
  /** Google AI (Gemini) API key. Default: GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** API base URL. Default: 'https://generativelanguage.googleapis.com/v1beta'. */
  baseUrl?: string;
  /**
   * Task type hint for the embedding.
   * Default: 'RETRIEVAL_QUERY'. Use 'RETRIEVAL_DOCUMENT' when storing.
   */
  taskType?: GoogleEmbedTaskType;
  /**
   * Optional document title, used only with taskType 'RETRIEVAL_DOCUMENT'.
   * Improves retrieval quality when provided alongside the document body.
   */
  title?: string;
  /**
   * Optional output dimensionality (truncation). Supported by text-embedding-004+.
   * When omitted, the model's full dimensionality is returned.
   */
  outputDimensionality?: number;
}

/**
 * Create an EmbedFn backed by the Google AI (Gemini) Embeddings API.
 * Uses native fetch - no SDK required.
 */
export function createGoogleEmbed(opts?: GoogleEmbedOptions): EmbedFn {
  const model = opts?.model ?? 'text-embedding-004';
  const baseUrl = opts?.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const taskType = opts?.taskType ?? 'RETRIEVAL_QUERY';

  return async (text: string): Promise<number[]> => {
    const apiKey = opts?.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Google API key is required. Set GOOGLE_API_KEY env var or pass apiKey in options.',
      );
    }

    const requestBody: Record<string, unknown> = {
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType,
    };

    if (opts?.title) {
      requestBody.title = opts.title;
    }
    if (opts?.outputDimensionality !== undefined) {
      requestBody.outputDimensionality = opts.outputDimensionality;
    }

    const res = await fetch(
      `${baseUrl}/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google AI API error: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { embedding: { values: number[] } };
    return json.embedding?.values ?? [];
  };
}
