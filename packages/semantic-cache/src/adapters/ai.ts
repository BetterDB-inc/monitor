import type { LanguageModelMiddleware } from 'ai';
import { SemanticCache } from '../SemanticCache';

export interface SemanticCacheMiddlewareOptions {
  /** A pre-configured SemanticCache instance. */
  cache: SemanticCache;
  /**
   * Extract the prompt text from AI SDK messages.
   * Default: joins all user message content text parts.
   */
  extractPrompt?: (params: { prompt: Array<{ role: string; content: unknown }> }) => string;
  /**
   * Extract the response text from an AI SDK result.
   * Default: finds the first text content part.
   */
  extractResponse?: (result: { content: Array<{ type: string; text?: string }> }) => string;
}

function defaultExtractPrompt(params: {
  prompt: Array<{ role: string; content: unknown }>;
}): string {
  const parts: string[] = [];
  for (const msg of params.prompt) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          (part as { type: string }).type === 'text' &&
          'text' in part
        ) {
          parts.push((part as { text: string }).text);
        }
      }
    }
  }
  return parts.join('\n');
}

function defaultExtractResponse(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  for (const part of result.content ?? []) {
    if (part.type === 'text' && part.text) {
      return part.text;
    }
  }
  return '';
}

/**
 * Creates a LanguageModelMiddleware that adds semantic caching to any
 * AI SDK language model. Use with wrapLanguageModel() from the 'ai' package.
 *
 * @example
 * ```typescript
 * import { wrapLanguageModel } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { createSemanticCacheMiddleware } from '@betterdb/semantic-cache/ai';
 *
 * const model = wrapLanguageModel({
 *   model: openai('gpt-4o'),
 *   middleware: createSemanticCacheMiddleware({ cache }),
 * });
 * ```
 */
export function createSemanticCacheMiddleware(
  opts: SemanticCacheMiddlewareOptions,
): LanguageModelMiddleware {
  const { cache } = opts;
  const extractPrompt = opts.extractPrompt ?? defaultExtractPrompt;
  const extractResponse = opts.extractResponse ?? defaultExtractResponse;
  let initPromise: Promise<void> | null = null;

  async function ensureInitialized(): Promise<void> {
    if (!initPromise) {
      initPromise = cache.initialize().catch((err) => {
        initPromise = null; // allow retry on transient failure
        throw err;
      });
    }
    await initPromise;
  }

  return {
    specificationVersion: 'v3',

    wrapGenerate: async ({ doGenerate, params }) => {
      await ensureInitialized();

      const prompt = extractPrompt(params as unknown as { prompt: Array<{ role: string; content: unknown }> });
      if (prompt) {
        try {
          const cached = await cache.check(prompt);
          if (cached.hit && cached.response) {
            // Return a minimal generate result. Cast required because
            // LanguageModelV3GenerateResult is imported transitively via the
            // LanguageModelMiddleware type — we construct it inline to avoid
            // depending on @ai-sdk/provider directly.
            return {
              content: [{ type: 'text', text: cached.response }],
              finishReason: 'stop',
              usage: { promptTokens: 0, completionTokens: 0 },
              warnings: [],
            } as unknown as Awaited<ReturnType<typeof doGenerate>>;
          }
        } catch {
          // Swallow check errors — caching should not break inference
        }
      }

      const result = await doGenerate();

      if (prompt) {
        const response = extractResponse(result as unknown as { content: Array<{ type: string; text?: string }> });
        if (response) {
          await cache.store(prompt, response).catch(() => {
            // Swallow store errors — caching should not break inference
          });
        }
      }

      return result;
    },

    // wrapStream is intentionally not implemented — semantic caching of
    // streaming responses is not supported in v0.1
  };
}
