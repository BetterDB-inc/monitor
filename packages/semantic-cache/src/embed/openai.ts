/**
 * OpenAI embedding helper for @betterdb/semantic-cache.
 *
 * Creates an EmbedFn backed by the OpenAI Embeddings API.
 * Requires the 'openai' peer dependency to be installed.
 *
 * Usage:
 *   import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';
 *   const embed = createOpenAIEmbed({ model: 'text-embedding-3-small' });
 *   const cache = new SemanticCache({ client, embedFn: embed });
 */
import type { EmbedFn } from '../types';

export interface OpenAIEmbedOptions {
  /**
   * Pre-configured OpenAI client instance.
   * If not provided, a new client is created using the OPENAI_API_KEY env var.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: any;
  /**
   * Embedding model ID.
   * Default: 'text-embedding-3-small' (1536 dimensions, best cost/quality tradeoff).
   */
  model?: string;
  /** OpenAI API key. Used only when client is not provided. Default: OPENAI_API_KEY env var. */
  apiKey?: string;
}

/**
 * Create an EmbedFn backed by the OpenAI Embeddings API.
 * Requires the 'openai' package to be installed as a peer dependency.
 */
export function createOpenAIEmbed(opts?: OpenAIEmbedOptions): EmbedFn {
  const model = opts?.model ?? 'text-embedding-3-small';
  let clientPromise: Promise<unknown> | null = null;

  function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        if (opts?.client) return opts.client;
        try {
          // @ts-ignore - openai is an optional peer dep
          const { OpenAI } = await import('openai');
          return new OpenAI({ apiKey: opts?.apiKey ?? process.env.OPENAI_API_KEY });
        } catch {
          throw new Error(
            '@betterdb/semantic-cache embed/openai requires the "openai" package. Install it: npm install openai',
          );
        }
      })();
    }
    return clientPromise;
  }

  return async (text: string): Promise<number[]> => {
    const client = (await getClient()) as {
      embeddings: {
        create: (params: {
          input: string;
          model: string;
        }) => Promise<{ data: Array<{ embedding: number[] }> }>;
      };
    };
    const response = await client.embeddings.create({ input: text, model });
    return response.data[0].embedding;
  };
}
