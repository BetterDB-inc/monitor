/**
 * Ollama embedding helper for @betterdb/semantic-cache.
 *
 * Supports local Ollama embedding models (nomic-embed-text, mxbai-embed-large, etc.).
 * Uses the Ollama REST API directly - no SDK required.
 *
 * Usage:
 *   import { createOllamaEmbed } from '@betterdb/semantic-cache/embed/ollama';
 *   const embed = createOllamaEmbed({ model: 'nomic-embed-text' });
 *   const cache = new SemanticCache({ client, embedFn: embed });
 */
import type { EmbedFn } from '../types';

export interface OllamaEmbedOptions {
  /**
   * Ollama embedding model name.
   * Default: 'nomic-embed-text' (768 dimensions).
   * Other options: 'mxbai-embed-large' (1024-dim), 'all-minilm' (384-dim).
   */
  model?: string;
  /**
   * Ollama API base URL.
   * Default: 'http://localhost:11434'
   */
  baseUrl?: string;
}

/**
 * Create an EmbedFn backed by a local Ollama instance.
 * Uses native fetch - no SDK required.
 */
export function createOllamaEmbed(opts?: OllamaEmbedOptions): EmbedFn {
  const model = opts?.model ?? 'nomic-embed-text';
  const baseUrl = opts?.baseUrl ?? (process.env.OLLAMA_HOST ?? 'http://localhost:11434');

  return async (text: string): Promise<number[]> => {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama API error: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings[0] ?? [];
  };
}
