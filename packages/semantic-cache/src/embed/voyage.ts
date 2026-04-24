/**
 * Voyage AI embedding helper for @betterdb/semantic-cache.
 *
 * Supports all Voyage AI embedding models (voyage-3, voyage-3-lite, etc.).
 * Uses the Voyage AI REST API directly - no SDK required.
 *
 * Usage:
 *   import { createVoyageEmbed } from '@betterdb/semantic-cache/embed/voyage';
 *   const embed = createVoyageEmbed({ model: 'voyage-3-lite' });
 *   const cache = new SemanticCache({ client, embedFn: embed });
 */
import type { EmbedFn } from '../types';

export interface VoyageEmbedOptions {
  /**
   * Voyage AI embedding model.
   * Default: 'voyage-3-lite' (512 dimensions, fastest and cheapest).
   * Other options: 'voyage-3' (1024-dim), 'voyage-3-large' (1024-dim).
   */
  model?: string;
  /** Voyage AI API key. Default: VOYAGE_API_KEY env var. */
  apiKey?: string;
  /** API base URL. Default: 'https://api.voyageai.com/v1'. */
  baseUrl?: string;
  /** Input type hint for retrieval tasks ('query' or 'document'). Default: 'query'. */
  inputType?: 'query' | 'document';
}

/**
 * Create an EmbedFn backed by the Voyage AI Embeddings API.
 * Uses native fetch - no SDK required.
 */
export function createVoyageEmbed(opts?: VoyageEmbedOptions): EmbedFn {
  const model = opts?.model ?? 'voyage-3-lite';
  const baseUrl = opts?.baseUrl ?? 'https://api.voyageai.com/v1';
  const inputType = opts?.inputType ?? 'query';

  return async (text: string): Promise<number[]> => {
    const apiKey = opts?.apiKey ?? process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Voyage AI API key is required. Set VOYAGE_API_KEY env var or pass apiKey in options.',
      );
    }

    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: [text], input_type: inputType }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Voyage AI API error: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data[0].embedding;
  };
}
