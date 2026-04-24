/**
 * Cohere embedding helper for @betterdb/semantic-cache.
 *
 * Supports Cohere Embed v3 models via the Cohere REST API.
 * Uses native fetch - no SDK required.
 *
 * Usage:
 *   import { createCohereEmbed } from '@betterdb/semantic-cache/embed/cohere';
 *   const embed = createCohereEmbed({ model: 'embed-english-v3.0' });
 *   const cache = new SemanticCache({ client, embedFn: embed });
 */
import type { EmbedFn } from '../types';

export interface CohereEmbedOptions {
  /**
   * Cohere embedding model.
   * Default: 'embed-english-v3.0' (1024 dimensions).
   * Other options: 'embed-multilingual-v3.0', 'embed-english-light-v3.0'.
   */
  model?: string;
  /** Cohere API key. Default: COHERE_API_KEY env var. */
  apiKey?: string;
  /** API base URL. Default: 'https://api.cohere.com/v2'. */
  baseUrl?: string;
  /**
   * Input type for embedding.
   * Default: 'search_query'. Use 'search_document' when storing.
   */
  inputType?: 'search_query' | 'search_document' | 'classification' | 'clustering';
}

/**
 * Create an EmbedFn backed by the Cohere Embed API.
 * Uses native fetch - no SDK required.
 */
export function createCohereEmbed(opts?: CohereEmbedOptions): EmbedFn {
  const model = opts?.model ?? 'embed-english-v3.0';
  const baseUrl = opts?.baseUrl ?? 'https://api.cohere.com/v2';
  const inputType = opts?.inputType ?? 'search_query';

  return async (text: string): Promise<number[]> => {
    const apiKey = opts?.apiKey ?? process.env.COHERE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Cohere API key is required. Set COHERE_API_KEY env var or pass apiKey in options.',
      );
    }

    const res = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        texts: [text],
        input_type: inputType,
        embedding_types: ['float'],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Cohere API error: ${res.status} ${body}`);
    }

    const json = (await res.json()) as {
      embeddings: { float: number[][] };
    };
    return json.embeddings.float[0] ?? [];
  };
}
