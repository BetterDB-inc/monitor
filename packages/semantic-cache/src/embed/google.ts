/**
 * Google AI (Gemini) embedding helper for @betterdb/semantic-cache.
 *
 * Supports gemini-embedding-2 and other Gemini embedding models via the
 * Google AI REST API. Uses native fetch - no SDK required.
 *
 * Usage:
 *   import { createGoogleEmbed } from '@betterdb/semantic-cache/embed/google';
 *   const embed = createGoogleEmbed({ model: 'gemini-embedding-2' });
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
   * Default: 'gemini-embedding-2'.
   * Other options: 'gemini-embedding-001'.
   *
   * Note: 'text-embedding-004' and 'embedding-001' were shut down by Google on
   * 2026-01-14 and 2025-10-30 respectively and no longer resolve.
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
   * Output dimensionality (Matryoshka truncation).
   * Default: 768, matching the dimensionality this provider has always
   * produced, so an existing vector index stays compatible. Pass 3072 for
   * gemini-embedding-2's full width.
   *
   * Note: gemini-embedding-2 re-normalizes truncated dimensions itself, but
   * gemini-embedding-001 does not — normalize its output before cosine
   * similarity when requesting anything other than 3072.
   */
  outputDimensionality?: number;
}

/**
 * Create an EmbedFn backed by the Google AI (Gemini) Embeddings API.
 * Uses native fetch - no SDK required.
 */
export function createGoogleEmbed(opts?: GoogleEmbedOptions): EmbedFn {
  const model = opts?.model ?? 'gemini-embedding-2';
  const baseUrl = opts?.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const taskType = opts?.taskType ?? 'RETRIEVAL_QUERY';
  const outputDimensionality = opts?.outputDimensionality ?? 768;

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

    if (opts?.title !== undefined) {
      requestBody.title = opts.title;
    }
    requestBody.outputDimensionality = outputDimensionality;

    const res = await fetch(`${baseUrl}/models/${model}:embedContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google AI API error: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { embedding: { values: number[] } };
    return json.embedding?.values ?? [];
  };
}
