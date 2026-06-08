import type { LanguageModelMiddleware } from 'ai';
import type { AgentCache } from '../AgentCache';
import type { LlmCacheParams } from '../types';

export interface AgentCacheMiddlewareOptions {
  /** A pre-configured AgentCache instance. */
  cache: AgentCache;
  /**
   * Extract the model name from AI SDK params.
   * Default: reads model.modelId (v6) or params.model.modelId (v5).
   */
  extractModel?: (params: unknown, model?: unknown) => string;
}

interface AiSdkMessage {
  role: string;
  content: unknown;
}

interface AiSdkModelV1 {
  modelId?: string;
  provider?: string;
}

interface AiSdkTool {
  type: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  id?: string;
  args?: unknown;
}

interface AiSdkParams {
  prompt?: AiSdkMessage[];
  model?: AiSdkModelV1;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
  tools?: AiSdkTool[];
  toolChoice?: unknown;
  seed?: number;
  stopSequences?: string[];
  responseFormat?: unknown;
}

function defaultExtractModel(params: unknown, model?: unknown): string {
  // In AI SDK v6 (provider spec v3), model is passed as a separate argument
  const m = model as AiSdkModelV1 | undefined;
  if (m?.modelId) return m.modelId;
  // Fallback: older versions may include model in params
  const p = params as AiSdkParams;
  return p.model?.modelId ?? 'unknown';
}

function convertTools(tools: AiSdkTool[]): LlmCacheParams['tools'] {
  return tools.map((t) => {
    if (t.type === 'function') {
      return {
        type: 'function',
        function: {
          name: t.name,
          ...(t.description != null ? { description: t.description } : {}),
          ...(t.inputSchema != null ? { parameters: t.inputSchema } : {}),
        },
      };
    }
    // Provider-defined tools (e.g. web_search)
    return {
      type: t.type,
      function: {
        name: t.name,
        ...(t.id != null ? { id: t.id } : {}),
        ...(t.args != null ? { args: t.args } : {}),
      },
    };
  });
}

function extractLlmParams(params: unknown, extractModel: (params: unknown, model?: unknown) => string, model?: unknown): LlmCacheParams {
  const p = params as AiSdkParams;

  const messages: Array<{ role: string; content: unknown }> = [];
  if (p.prompt && Array.isArray(p.prompt)) {
    for (const msg of p.prompt) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  const result: LlmCacheParams = {
    model: extractModel(params, model),
    messages,
    temperature: p.temperature,
    top_p: p.topP,
    max_tokens: p.maxTokens ?? p.maxOutputTokens,
  };
  if (p.tools != null && p.tools.length > 0) result.tools = convertTools(p.tools);
  if (p.toolChoice != null) result.toolChoice = p.toolChoice;
  if (p.seed != null) result.seed = p.seed;
  if (p.stopSequences != null) result.stop = p.stopSequences;
  if (p.responseFormat != null) result.responseFormat = p.responseFormat;

  return result;
}

interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

function isTextOnlyResponse(content: ContentPart[]): boolean {
  return content.length > 0 && content.every((part) => part.type === 'text');
}

function extractTextFromContent(content: ContentPart[]): string {
  return content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text!)
    .join('');
}

/**
 * Creates a LanguageModelMiddleware that adds exact-match caching to any
 * AI SDK language model. Use with wrapLanguageModel() from the 'ai' package.
 *
 * @example
 * ```typescript
 * import { wrapLanguageModel } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { createAgentCacheMiddleware } from '@betterdb/agent-cache/ai';
 *
 * const model = wrapLanguageModel({
 *   model: openai('gpt-4o'),
 *   middleware: createAgentCacheMiddleware({ cache }),
 * });
 * ```
 */
export function createAgentCacheMiddleware(
  opts: AgentCacheMiddlewareOptions,
): LanguageModelMiddleware {
  const { cache } = opts;
  const extractModel = opts.extractModel ?? defaultExtractModel;

  return {
    // Required literal by LanguageModelV3Middleware from @ai-sdk/provider.
    // If the ai package bumps to a v4 spec, this must be updated alongside
    // the peer dependency range in package.json ("ai": "^6.0.135").
    specificationVersion: 'v3',

    wrapGenerate: async ({ doGenerate, params, model: modelRef }) => {
      const llmParams = extractLlmParams(params, extractModel, modelRef);

      // Only cache if we have messages
      if (llmParams.messages.length > 0) {
        try {
          const cached = await cache.llm.check(llmParams);
          if (cached.hit && cached.response) {
            // Return a minimal generate result with required fields only.
            // Intentionally omits: rawCall, rawResponse, response, request —
            // these describe the actual API call which didn't happen on a cache
            // hit. AI SDK consumers (generateText, streamText) tolerate their
            // absence; they're only used for debugging/logging.
            // providerMetadata.agentCache.hit lets consumers identify cached
            // responses and exclude them from usage/cost accounting.
            return {
              content: [{ type: 'text', text: cached.response }],
              finishReason: 'stop',
              usage: {
                inputTokens: { total: 0 },
                outputTokens: { total: 0 },
              },
              warnings: [],
              providerMetadata: { agentCache: { hit: true } },
            } as unknown as Awaited<ReturnType<typeof doGenerate>>;
          }
        } catch {
          // Swallow check errors - caching should not break inference
        }
      }

      const result = await doGenerate();

      // Only cache text-only responses. Responses containing tool_call parts or
      // other non-text content types are not cacheable -- tool calls depend on
      // runtime state and caching them would break tool-calling workflows.
      if (llmParams.messages.length > 0) {
        const r = result as { content?: ContentPart[]; usage?: { inputTokens?: { total?: number }; outputTokens?: { total?: number } } };
        if (r.content && Array.isArray(r.content) && isTextOnlyResponse(r.content)) {
          const response = extractTextFromContent(r.content);
          if (response) {
            const inputTotal = r.usage?.inputTokens?.total;
            const outputTotal = r.usage?.outputTokens?.total;
            const tokens = inputTotal !== undefined && outputTotal !== undefined
              ? { input: inputTotal, output: outputTotal }
              : undefined;

            await cache.llm.store(llmParams, response, tokens ? { tokens } : undefined).catch(() => {
              // Swallow store errors - caching should not break inference
            });
          }
        }
      }

      return result;
    },

    // Streaming not supported - accumulate full response before caching
  };
}
