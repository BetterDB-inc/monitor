import { BaseCache } from '@langchain/core/caches';
import {
  BaseChatModel,
  type BaseChatModelParams,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, AIMessageChunk, ToolMessage, type UsageMetadata } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult, type ChatGeneration, type Generation } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { concat } from '@langchain/core/utils/stream';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { AgentCache } from '../AgentCache';
import type { LlmCacheParams, LlmCacheResult } from '../types';
import type { ContentBlock, TextBlock, ToolCallBlock } from '../utils';

export interface BetterDBLlmCacheOptions {
  /** A pre-configured AgentCache instance. */
  cache: AgentCache;
}

/** Try to extract a model name like "gpt-4o-mini" from LangChain's llm_string.
 *
 * LangChain serializes the key as: `_model:"chatModel",_type:"openai",model_name:"gpt-4o-mini",...`
 * (comma-separated key:JSON-value pairs, sorted alphabetically). Not pure JSON.
 */
function extractModelName(llmString: string): string {
  const match = llmString.match(/\bmodel_name:"([^"]+)"/);
  if (match) return match[1];
  // Fallback for plain JSON format (older LangChain versions)
  try {
    const parsed = JSON.parse(llmString);
    return parsed.model_name ?? parsed.model ?? llmString;
  } catch {
    return llmString;
  }
}

interface ChatGenerationLike extends Generation {
  message?: { usage_metadata?: UsageMetadata };
}

export class BetterDBLlmCache extends BaseCache {
  private cache: AgentCache;

  constructor(opts: BetterDBLlmCacheOptions) {
    super();
    this.cache = opts.cache;
  }

  async lookup(prompt: string, llm_string: string): Promise<Generation[] | null> {
    // LangChain passes the full serialized prompt as `prompt`
    // and the model config string as `llm_string`.
    // Hash them together as a single LLM cache check.
    const result = await this.cache.llm.check({
      model: extractModelName(llm_string),
      messages: [{ role: 'user', content: prompt }],
    });

    if (!result.hit || !result.response) return null;

    // Return ChatGeneration-shaped objects with a proper AIMessage.
    // We cannot store/return full ChatGeneration class instances because
    // AIMessage does not survive JSON round-tripping. Instead we store
    // only the text and reconstruct the message on lookup.
    try {
      const parsed: Array<{ text?: string }> = JSON.parse(result.response);
      return parsed.map((g) => {
        const text = g.text ?? '';
        return { text, message: new AIMessage(text) } as Generation;
      });
    } catch {
      return [{ text: result.response, message: new AIMessage(result.response) } as Generation];
    }
  }

  async update(prompt: string, llm_string: string, return_val: Generation[]): Promise<void> {
    // Store only the text from each generation — class instances
    // (AIMessage, ChatGeneration) are not JSON-round-trip safe.
    const stripped = return_val.map((g) => ({ text: g.text }));
    const text = JSON.stringify(stripped);
    if (!text) return;

    // Extract token counts from the AIMessage's usage_metadata (set by @langchain/openai)
    const first = return_val[0] as ChatGenerationLike | undefined;
    const usage = first?.message?.usage_metadata;
    const tokens = usage?.input_tokens !== undefined && usage?.output_tokens !== undefined
      ? { input: usage.input_tokens, output: usage.output_tokens }
      : undefined;

    await this.cache.llm.store(
      { model: extractModelName(llm_string), messages: [{ role: 'user', content: prompt }] },
      text,
      tokens ? { tokens } : undefined,
    );
  }
}

// ── CachedChatModel ───────────────────────────────────────────────────────────

export interface CachedChatModelOptions extends Omit<BaseChatModelParams, 'cache'> {
  /** The chat model to wrap (e.g. new ChatOpenAI({...})). */
  model: BaseChatModel;
  /** A pre-configured AgentCache instance. */
  cache: AgentCache;
  /** Optional override for the model name used in the cache key. */
  modelName?: string;
}

/** CachedChatModel's own call options — `tools` isn't on the generic base type. */
export interface CachedChatModelCallOptions extends BaseChatModelCallOptions {
  tools?: unknown[];
}

function modelNameOf(model: BaseChatModel): string {
  const m = model as BaseChatModel & { modelName?: string; model?: string };
  return m.modelName ?? m.model ?? model._llmType();
}

function textOf(msg: AIMessage): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text?: string } =>
          typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
      )
      .map((part) => part.text ?? '')
      .join('');
  }
  return '';
}

function convertMessage(
  m: BaseMessage,
): { role: string; content: unknown; toolCallId?: string; name?: string } {
  const type = m.getType();
  const role =
    type === 'human' ? 'user'
    : type === 'ai' ? 'assistant'
    : type === 'system' ? 'system'
    : type === 'tool' ? 'tool'
    : type;

  if (type === 'tool') {
    const tm = m as ToolMessage;
    const text = typeof tm.content === 'string'
      ? tm.content
      : Array.isArray(tm.content)
        ? tm.content
          .filter(
            (part): part is { type: string; text?: string } =>
              typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
          )
          .map((part) => part.text ?? '')
          .join('')
        : String(tm.content ?? '');
    return {
      role: 'tool',
      toolCallId: tm.tool_call_id,
      content: [{ type: 'text', text } as TextBlock],
      ...(tm.name ? { name: tm.name } : {}),
    };
  }

  if (type === 'ai') {
    const am = m as AIMessage;
    const blocks: ContentBlock[] = [];
    if (typeof am.content === 'string' && am.content !== '') {
      blocks.push({ type: 'text', text: am.content });
    } else if (Array.isArray(am.content)) {
      for (const part of am.content) {
        if (typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text') {
          blocks.push({ type: 'text', text: (part as { text?: string }).text ?? '' });
        }
      }
    }
    const toolCalls = (am as AIMessage & {
      tool_calls?: Array<{ id?: string; name: string; args: unknown }>;
    }).tool_calls;
    if (toolCalls) {
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool_call',
          id: tc.id ?? '',
          name: tc.name,
          args: tc.args,
        });
      }
    }
    return { role: 'assistant', content: blocks };
  }

  if (typeof m.content === 'string') {
    return { role, content: m.content };
  }

  if (Array.isArray(m.content)) {
    const blocks: TextBlock[] = [];
    for (const part of m.content) {
      if (typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text') {
        blocks.push({ type: 'text', text: (part as { text?: string }).text ?? '' });
      }
    }
    return { role, content: blocks.length > 0 ? blocks : '' };
  }

  return { role, content: String(m.content ?? '') };
}

type LlmCacheTool = NonNullable<LlmCacheParams['tools']>[number];

/**
 * Normalize any LangChain tool into a stable, canonical cache-key shape.
 *
 * IMPORTANT: never put a raw Zod schema into the cache key. Tools built with
 * `tool()` / `DynamicStructuredTool` carry a Zod schema, and Zod v3 stores the
 * object shape as a lazy function on `_def.shape`. The key is built with
 * `canonicalJson()` (JSON.stringify + sorted keys), which drops functions — so
 * `get_weather({city})` and `get_weather({city, units})` would hash IDENTICALLY,
 * which is exactly the tool-schema drift this adapter exists to prevent.
 *
 * `convertToOpenAITool` is LangChain's own normalizer: it converts Zod schemas
 * to JSON Schema and passes already-OpenAI-format tools through unchanged.
 */
function convertTools(tools: unknown[] | undefined): LlmCacheParams['tools'] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const converted: LlmCacheTool[] = [];

  for (const t of tools) {
    if (typeof t !== 'object' || t === null) continue;

    let def: ReturnType<typeof convertToOpenAITool>;
    try {
      def = convertToOpenAITool(t as Parameters<typeof convertToOpenAITool>[0]);
    } catch {
      // Unconvertible tool: skip it rather than poisoning the key with an
      // opaque object that may not serialize deterministically.
      continue;
    }

    const name = def?.function?.name;
    if (typeof name !== 'string' || name === '') continue;

    // `$schema` differs between zod v3 (draft-07) and v4 (2020-12). Excluding it
    // keeps cache keys stable across a zod major bump.
    const { $schema: _ignored, ...parameters } = (def.function.parameters ?? {}) as Record<
      string,
      unknown
    >;

    converted.push({
      type: 'function',
      function: {
        name,
        ...(def.function.description != null ? { description: def.function.description } : {}),
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      },
    });
  }

  return converted.length > 0 ? converted : undefined;
}

function tokensOf(msg: AIMessage): { input: number; output: number } | undefined {
  const usage = msg.usage_metadata as UsageMetadata | undefined;
  if (usage?.input_tokens !== undefined && usage?.output_tokens !== undefined) {
    return { input: usage.input_tokens, output: usage.output_tokens };
  }

  const respMeta = msg.response_metadata as {
    token_usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | undefined;
  const tu = respMeta?.token_usage;
  if (tu?.prompt_tokens !== undefined && tu?.completion_tokens !== undefined) {
    return { input: tu.prompt_tokens, output: tu.completion_tokens };
  }

  return undefined;
}

function buildToolCallBlocks(msg: AIMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const text = textOf(msg);
  if (text) blocks.push({ type: 'text', text });
  const toolCalls = (msg as AIMessage & {
    tool_calls?: Array<{ id?: string; name: string; args: unknown }>;
  }).tool_calls;
  if (toolCalls) {
    for (const tc of toolCalls) {
      blocks.push({
        type: 'tool_call',
        id: tc.id ?? '',
        name: tc.name,
        args: tc.args,
      });
    }
  }
  return blocks;
}

function rebuildGeneration(cached: LlmCacheResult): ChatGeneration | null {
  if (!cached.hit) return null;

  if (cached.contentBlocks?.some((b) => b.type === 'tool_call')) {
    const toolCalls = cached.contentBlocks
      .filter((b): b is ToolCallBlock => b.type === 'tool_call')
      .map((b) => ({
        id: b.id,
        name: b.name,
        args: b.args as Record<string, unknown>,
      }));
    const text = cached.response ?? '';
    const message = new AIMessage({ content: text, tool_calls: toolCalls });
    return { text, message };
  }

  if (cached.response != null) {
    return { text: cached.response, message: new AIMessage(cached.response) };
  }

  return null;
}

/**
 * A BaseChatModel wrapper that caches AND keys on bound tool schemas —
 * closing the tool-schema limitation of the BaseCache-based `BetterDBLlmCache`.
 *
 *   const model = new CachedChatModel({ model: new ChatOpenAI({ model: 'gpt-4o' }), cache });
 *   const withTools = model.bindTools([...]);   // tools are now in the cache key
 *   await withTools.invoke(messages);
 *
 * Implementation note: BaseChatModel.bindTools has no default implementation,
 * and Runnable.bind() does not exist in this dependency line (@langchain/core
 * ^1.1.35) — it was superseded by withConfig(). This mirrors the pattern
 * ChatOpenAI itself uses internally: bindTools() -> this.withConfig({ tools }).
 */
export class CachedChatModel extends BaseChatModel<CachedChatModelCallOptions> {
  private inner: BaseChatModel;
  private agentCache: AgentCache;
  private modelNameOverride?: string;

  constructor(opts: CachedChatModelOptions) {
    const { model, cache, modelName, ...baseParams } = opts;
    super(baseParams);
    this.inner = model;
    this.agentCache = cache;
    this.modelNameOverride = modelName;
  }

  _llmType(): string {
    // NOTE: BaseChatModel calls _llmType() during super(), i.e. BEFORE `inner` is
    // assigned in our constructor. The optional chaining is load-bearing — without
    // it, constructing a CachedChatModel throws.
    const innerType = this.inner?._llmType?.() ?? 'chat';
    return `betterdb-cached(${innerType})`;
  }

  /**
   * `BaseChatModel.bindTools` has no default implementation, and this dependency
   * line (@langchain/core ^1.1.35) has no `Runnable.bind()` — it was superseded
   * by `withConfig()`. This mirrors what `ChatOpenAI.bindTools` does internally:
   * `bindTools()` → `this.withConfig({ tools })`, which puts `tools` into the
   * call options that `_generate` / `_streamResponseChunks` receive.
   *
   * Returns a new runnable and does not mutate this instance — the same contract
   * as every other LangChain chat model.
   */
  bindTools(
    tools: unknown[],
    kwargs?: Partial<CachedChatModelCallOptions>,
  ): ReturnType<NonNullable<BaseChatModel['bindTools']>> {
    return this.withConfig({ tools, ...kwargs } as Partial<CachedChatModelCallOptions>);
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const tools = options.tools;

    // Strip `tools` from the options we forward: they are already bound onto the
    // inner model in provider-formatted form, and passing the raw cache-key
    // tools through here would overwrite them.
    const { tools: _rawTools, ...restOptions } = options as Record<string, unknown>;

    const params = this.toParams(messages, tools, restOptions);

    try {
      const cached = await this.agentCache.llm.check(params);
      if (cached.hit) {
        const gen = rebuildGeneration(cached);
        if (gen) return { generations: [gen] };
      }
    } catch {
      // never let a cache read break inference
    }

    const innerModel = this.bindInner(tools);
    const result = (await innerModel.invoke(messages, restOptions as never)) as AIMessage;

    try {
      await this.persist(params, result);
    } catch {
      // fail-open: caching must never break the call
    }

    const generation: ChatGeneration = { text: textOf(result), message: result };
    return { generations: [generation] };
  }

  /**
   * Cache-aware streaming. On a hit, the stored response is replayed as a single
   * chunk and the wrapped model is never called. On a miss, every upstream chunk
   * is passed through untouched while being accumulated, and the aggregated
   * message is persisted once the stream completes (fail-open).
   *
   * Cached streams replay as one chunk — the same trade-off documented for the
   * Vercel AI SDK adapter's `wrapStream`.
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const tools = options.tools;
    const { tools: _rawTools, ...restOptions } = options as Record<string, unknown>;
    const params = this.toParams(messages, tools, restOptions);

    // ── hit: replay, skip the model ────────────────────────────────────────
    try {
      const cached = await this.agentCache.llm.check(params);
      if (cached.hit) {
        const gen = rebuildGeneration(cached);
        if (gen) {
          const toolCalls = (gen.message as AIMessage).tool_calls ?? [];
          const message = new AIMessageChunk({
            content: gen.text,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
          await runManager?.handleLLMNewToken(gen.text);
          yield new ChatGenerationChunk({ text: gen.text, message });
          return;
        }
      }
    } catch {
      // never let a cache read break inference
    }

    // ── miss: pass through, accumulate, store on completion ────────────────
    const innerModel = this.bindInner(tools);
    let aggregate: AIMessageChunk | undefined;

    for await (const chunk of await innerModel.stream(messages, restOptions as never)) {
      const messageChunk = chunk as AIMessageChunk;
      aggregate = aggregate === undefined ? messageChunk : concat(aggregate, messageChunk);
      const text = typeof messageChunk.content === 'string' ? messageChunk.content : '';
      await runManager?.handleLLMNewToken(text);
      yield new ChatGenerationChunk({ text, message: messageChunk });
    }

    if (aggregate !== undefined) {
      try {
        await this.persist(params, aggregate as unknown as AIMessage);
      } catch {
        // fail-open: the stream was already delivered in full
      }
    }
  }

  private toParams(
    messages: BaseMessage[],
    tools: unknown[] | undefined,
    callOptions: Record<string, unknown>,
  ): LlmCacheParams {
    const params: LlmCacheParams = {
      model: this.modelNameOverride ?? modelNameOf(this.inner),
      messages: messages.map(convertMessage),
    };

    const converted = convertTools(tools);
    if (converted && converted.length > 0) params.tools = converted;

    if (callOptions.tool_choice !== undefined) params.toolChoice = callOptions.tool_choice;

    // Sampling params live on the wrapped model's constructor, not in call
    // options. Key on them so two models differing only by temperature don't
    // share an entry — consistent with the openai/anthropic/ai adapters.
    const inv = this.readInvocationParams(callOptions);
    if (typeof inv.temperature === 'number') params.temperature = inv.temperature;
    if (typeof inv.top_p === 'number') params.top_p = inv.top_p;
    if (typeof inv.max_tokens === 'number') params.max_tokens = inv.max_tokens;
    if (typeof inv.seed === 'number') params.seed = inv.seed;
    if (Array.isArray(inv.stop)) params.stop = inv.stop as string[];

    return params;
  }

  /** Best-effort read of the wrapped model's invocation params. Never throws. */
  private readInvocationParams(callOptions: Record<string, unknown>): Record<string, unknown> {
    try {
      const inner = this.inner as BaseChatModel & {
        invocationParams?: (opts?: unknown) => unknown;
      };
      const inv = inner.invocationParams?.(callOptions);
      return inv && typeof inv === 'object' ? (inv as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * CachedChatModel owns cache keying (canonical JSON Schema); the inner model
   * owns provider-specific wire formatting. Re-bind the raw tools onto the inner
   * model so it formats and sends them itself.
   */
  private bindInner(tools: unknown[] | undefined): BaseChatModel | ReturnType<
    NonNullable<BaseChatModel['bindTools']>
  > {
    if (!tools || tools.length === 0) return this.inner;
    return this.inner.bindTools?.(tools as never) ?? this.inner;
  }

  private async persist(params: LlmCacheParams, msg: AIMessage): Promise<void> {
    const tokens = tokensOf(msg);
    const toolCalls = (msg as AIMessage & {
      tool_calls?: Array<{ id?: string; name: string; args: unknown }>;
    }).tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const blocks = buildToolCallBlocks(msg);
      await this.agentCache.llm.storeMultipart(params, blocks, tokens ? { tokens } : {});
    } else {
      await this.agentCache.llm.store(params, textOf(msg), tokens ? { tokens } : {});
    }
  }
}
