import { BaseCache } from '@langchain/core/caches';
import {
  BaseChatModel,
  type BaseChatModelParams,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type ToolCallChunk,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult, type ChatGeneration, type Generation } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { JsonOutputKeyToolsParser } from '@langchain/core/output_parsers/openai_tools';
import { RunnablePassthrough, RunnableSequence } from '@langchain/core/runnables';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { getSchemaDescription, isInteropZodSchema } from '@langchain/core/utils/types';
import { concat } from '@langchain/core/utils/stream';
import {
  BaseCallbackHandler,
  type HandleLLMNewTokenCallbackFields,
  type NewTokenIndices,
} from '@langchain/core/callbacks/base';
import { CallbackManager, CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { AgentCache } from '../AgentCache';
import type { LlmCacheParams, LlmCacheResult } from '../types';
import { canonicalJson, sha256 } from '../utils';
import type { BinaryBlock, ContentBlock, ReasoningBlock, TextBlock, ToolCallBlock } from '../utils';

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
  /** Applied to every bound tool, as `ChatOpenAI.bindTools(tools, { strict })` does. */
  strict?: boolean;
  /**
   * @internal The `kwargs` given to `bindTools()`, re-applied when the raw tools
   * are bound onto the wrapped model so bind-time options are not lost.
   */
  bindToolsKwargs?: Record<string, unknown>;
}

/**
 * invocationParams() keys that are never part of the cache key:
 * - stream / stream_options: transport only, so invoke() and stream() share entries
 * - tools / tool_choice / strict: keyed separately (canonical JSON Schema with per-tool
 *   `strict`, plus the call-option tool_choice)
 * - model / model_name / modelName: keyed as `model` (and overridable via `modelName`)
 * - signal / timeout / callbacks / promptIndex: per-request runtime plumbing, not
 *   request semantics (BaseChatModel adds promptIndex to the parsed call options)
 */
const INVOCATION_PARAMS_DENYLIST = new Set([
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'strict',
  'model',
  'model_name',
  'modelName',
  'signal',
  'timeout',
  'callbacks',
  'promptIndex',
]);

/** Anthropic rejects a forced tool_choice while extended thinking is on. */
const THINKING_ON = new Set(['enabled', 'adaptive']);

let warnedUncacheableTools = false;

function modelNameOf(model: BaseChatModel): string {
  const m = model as BaseChatModel & { modelName?: string; model?: string };
  return m.modelName ?? m.model ?? model._llmType();
}

function textOfContent(content: unknown): string {
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

function textOf(msg: AIMessage): string {
  return textOfContent(msg.content);
}

/** JSON round-trip; undefined when the value cannot be represented as JSON. */
function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return undefined;
  }
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length > 0;
}

/**
 * Map a thinking / redacted_thinking part to the same ReasoningBlock shape the
 * Anthropic adapter uses (anthropic.ts normalizeBlock), so the canonical form
 * is independent of transport-only fields such as a streamed part's `index`.
 */
function reasoningBlockOf(p: Record<string, unknown>): ReasoningBlock | null {
  if (p.type === 'thinking') {
    return {
      type: 'reasoning',
      text: typeof p.thinking === 'string' ? p.thinking : '',
      ...(typeof p.signature === 'string' ? { opaqueSignature: p.signature } : {}),
    };
  }
  if (p.type === 'redacted_thinking') {
    return {
      type: 'reasoning',
      text: '',
      redacted: true,
      ...(typeof p.data === 'string' ? { opaqueSignature: p.data } : {}),
    };
  }
  return null;
}

/** Content parts that only restate `tool_calls` (keyed from `tool_calls` instead). */
const TOOL_CALL_PART_TYPES = new Set(['tool_use', 'input_json_delta', 'function_call']);

/**
 * Map one LangChain content part to a cache-key block. Text parts keep the
 * existing shape; image parts hash their full payload into a BinaryBlock ref;
 * thinking parts become ReasoningBlocks; any other part type is serialized
 * canonically so it still affects the key (dropping it would let two different
 * requests share one entry).
 */
function convertPart(part: unknown): ContentBlock {
  const p = (typeof part === 'object' && part !== null ? part : { value: part }) as Record<
    string,
    unknown
  > & { type?: string; text?: string };
  if (p.type === 'text') return { type: 'text', text: p.text ?? '' };
  if (p.type === 'image_url' || p.type === 'image') {
    const block: BinaryBlock = {
      type: 'binary',
      kind: 'image',
      mediaType: 'image/*',
      ref: sha256(canonicalJson(p)),
    };
    return block;
  }
  const reasoning = reasoningBlockOf(p);
  if (reasoning) return reasoning;
  return { type: 'text', text: `[${p.type ?? 'unknown'}]${canonicalJson(p)}` };
}

type ToolCallLike = { id?: string; name: string; args: unknown };

function toolCallsOf(msg: AIMessage): ToolCallLike[] {
  return ((msg as AIMessage & { tool_calls?: ToolCallLike[] }).tool_calls ?? []);
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
    const content: ContentBlock[] = typeof tm.content === 'string'
      ? [{ type: 'text', text: tm.content }]
      : Array.isArray(tm.content)
        ? tm.content.map(convertPart)
        : [{ type: 'text', text: String(tm.content ?? '') }];
    return {
      role: 'tool',
      toolCallId: tm.tool_call_id,
      content,
      ...(tm.name ? { name: tm.name } : {}),
    };
  }

  if (type === 'ai') {
    // A live provider message and the same message replayed from the cache must
    // produce identical blocks, or every turn after a hit misses. So: string vs
    // array content of the same text yields the same TextBlocks, thinking parts
    // become ReasoningBlocks, and tool_use / function_call parts are skipped
    // because `tool_calls` (below) already represents them.
    const am = m as AIMessage;
    const blocks: ContentBlock[] = [];
    if (typeof am.content === 'string' && am.content !== '') {
      blocks.push({ type: 'text', text: am.content });
    } else if (Array.isArray(am.content)) {
      for (const part of am.content) {
        const t = (part as { type?: string } | null)?.type;
        if (t !== undefined && TOOL_CALL_PART_TYPES.has(t)) continue;
        blocks.push(convertPart(part));
      }
    }
    for (const tc of toolCallsOf(am)) {
      blocks.push({ type: 'tool_call', id: tc.id ?? '', name: tc.name, args: tc.args });
    }
    return { role: 'assistant', content: blocks };
  }

  if (typeof m.content === 'string') {
    return { role, content: m.content };
  }

  if (Array.isArray(m.content)) {
    const blocks = m.content.map(convertPart);
    return { role, content: blocks.length > 0 ? blocks : '' };
  }

  return { role, content: String(m.content ?? '') };
}

type LlmCacheTool = NonNullable<LlmCacheParams['tools']>[number];

/**
 * Anthropic-native custom tool definitions ({ name, description, input_schema })
 * are accepted by ChatAnthropic.bindTools but are not LangChain tools, so
 * convertToOpenAITool passes them through without a `function` field.
 */
function fromAnthropicToolShape(t: Record<string, unknown>): ReturnType<typeof convertToOpenAITool> | null {
  if (
    typeof t.name === 'string' &&
    typeof t.input_schema === 'object' && t.input_schema !== null &&
    t.type === undefined && t.function === undefined && t.schema === undefined
  ) {
    return {
      type: 'function',
      function: {
        name: t.name,
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        parameters: t.input_schema as Record<string, unknown>,
      },
    } as ReturnType<typeof convertToOpenAITool>;
  }
  return null;
}

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
 *
 * `strictOverride` mirrors ChatOpenAI.bindTools(tools, { strict }): when set it
 * replaces each tool's own `function.strict`. Strict and non-strict tools get
 * different keys because strict mode changes what the model may return.
 */
function convertTools(tools: unknown[] | undefined, strictOverride?: boolean): {
  tools?: LlmCacheParams['tools'];
  /** False when any bound tool could not be converted, so the key can't represent it. */
  complete: boolean;
} {
  if (!tools || tools.length === 0) return { complete: true };
  let complete = true;

  const converted: LlmCacheTool[] = [];

  for (const t of tools) {
    if (typeof t !== 'object' || t === null) {
      complete = false;
      continue;
    }

    let def: ReturnType<typeof convertToOpenAITool>;
    try {
      def = fromAnthropicToolShape(t as Record<string, unknown>) ??
        convertToOpenAITool(t as Parameters<typeof convertToOpenAITool>[0]);
    } catch {
      // Unconvertible tool: the key can't represent it, so the caller must
      // bypass the cache rather than key on fewer tools than the model gets.
      complete = false;
      continue;
    }

    const name = def?.function?.name;
    if (typeof name !== 'string' || name === '') {
      complete = false;
      continue;
    }

    // `$schema` differs between zod v3 (draft-07) and v4 (2020-12). Excluding it
    // keeps cache keys stable across a zod major bump.
    const { $schema: _ignored, ...parameters } = (def.function.parameters ?? {}) as Record<
      string,
      unknown
    >;
    const strict = strictOverride ?? (def.function as { strict?: unknown }).strict;

    converted.push({
      type: 'function',
      function: {
        name,
        ...(def.function.description != null ? { description: def.function.description } : {}),
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        ...(typeof strict === 'boolean' ? { strict } : {}),
      },
    });
  }

  return { tools: converted.length > 0 ? converted : undefined, complete };
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

// ── Response snapshot / replay ────────────────────────────────────────────────

/** Version tag for the `metadata` envelope this adapter stores with each entry. */
const SNAPSHOT_VERSION = 1;

/**
 * What CachedChatModel stores in `LlmStoreOptions.metadata`. Content itself is
 * stored as canonical ContentBlocks; this envelope records what the blocks
 * can't: the original content shape and the AIMessage fields outside content.
 *
 * The message `id` is deliberately not stored. A replayed entry must not carry
 * the id of the response it was cached from: LangGraph's messagesStateReducer
 * merges by id, so two hits of the same entry in one thread would replace each
 * other instead of being appended. On a hit the id is left unset and
 * BaseChatModel assigns a fresh `run-<runId>`.
 */
interface MessageSnapshotMeta {
  langchain: number;
  /** 'array' when the provider returned content parts (e.g. Anthropic). */
  contentShape: 'string' | 'array';
  /** Tool calls that also appeared as `tool_use` parts inside array content. */
  toolUseIds?: string[];
  additional_kwargs?: Record<string, unknown>;
  response_metadata?: Record<string, unknown>;
  invalid_tool_calls?: Array<{ id?: string; name?: string; args?: string; error?: string }>;
}

interface MessageSnapshot {
  blocks: ContentBlock[];
  text: string;
  multipart: boolean;
  meta: MessageSnapshotMeta;
}

/** Keys a text part may carry and still be replayed faithfully. */
function isPlainTextPart(p: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(p)) {
    if (k === 'type' || k === 'text' || k === 'index') continue;
    // OpenAI Responses-API text parts carry `annotations: []`; only empty is replayable.
    if ((k === 'annotations' || k === 'citations') && (v == null || (Array.isArray(v) && v.length === 0))) {
      continue;
    }
    return false;
  }
  return true;
}

function isPlainReasoningPart(p: Record<string, unknown>): boolean {
  const allowed = p.type === 'thinking'
    ? ['type', 'thinking', 'signature', 'index']
    : ['type', 'data', 'index'];
  return Object.keys(p).every((k) => allowed.includes(k));
}

/**
 * Capture everything needed to rebuild `msg` on a hit. Returns null when the
 * content holds a part this adapter cannot replay faithfully (citations, server
 * tool results, …): such responses are passed through but not cached, because a
 * lossy replay can break the next turn (Anthropic rejects an assistant turn
 * whose thinking blocks were stripped).
 */
function snapshotMessage(msg: AIMessage): MessageSnapshot | null {
  const toolCalls = toolCallsOf(msg);
  const byId = new Map(toolCalls.filter((tc) => tc.id).map((tc) => [tc.id as string, tc]));
  const emitted = new Set<ToolCallLike>();
  const blocks: ContentBlock[] = [];
  const toolUseIds: string[] = [];
  const isArray = Array.isArray(msg.content);

  if (typeof msg.content === 'string') {
    if (msg.content !== '') blocks.push({ type: 'text', text: msg.content });
  } else if (isArray) {
    for (const raw of msg.content as unknown[]) {
      if (typeof raw !== 'object' || raw === null) return null;
      const p = raw as Record<string, unknown>;
      if (p.type === 'text') {
        if (!isPlainTextPart(p)) return null;
        blocks.push({ type: 'text', text: typeof p.text === 'string' ? p.text : '' });
      } else if (p.type === 'thinking' || p.type === 'redacted_thinking') {
        if (!isPlainReasoningPart(p)) return null;
        blocks.push(reasoningBlockOf(p) as ReasoningBlock);
      } else if (p.type === 'tool_use' || p.type === 'input_json_delta') {
        // Keep the part's position; args come from the parsed tool_calls entry.
        const tc = typeof p.id === 'string' ? byId.get(p.id) : undefined;
        if (!tc) {
          // A streamed input_json_delta fragment without an id belongs to the
          // preceding tool_use part, which already carries the call.
          if (p.type === 'input_json_delta' && p.id === undefined) continue;
          return null;
        }
        if (emitted.has(tc)) continue;
        emitted.add(tc);
        toolUseIds.push(tc.id as string);
        blocks.push({ type: 'tool_call', id: tc.id as string, name: tc.name, args: tc.args });
      } else {
        return null;
      }
    }
  } else {
    return null;
  }

  for (const tc of toolCalls) {
    if (emitted.has(tc)) continue;
    blocks.push({ type: 'tool_call', id: tc.id ?? '', name: tc.name, args: tc.args });
  }

  const meta: MessageSnapshotMeta = {
    langchain: SNAPSHOT_VERSION,
    contentShape: isArray ? 'array' : 'string',
  };
  if (toolUseIds.length > 0) meta.toolUseIds = toolUseIds;
  const additional = toJsonSafe(msg.additional_kwargs);
  if (isNonEmptyObject(additional)) meta.additional_kwargs = additional;
  const responseMeta = toJsonSafe(msg.response_metadata);
  if (isNonEmptyObject(responseMeta)) meta.response_metadata = responseMeta;
  const invalid = toJsonSafe((msg as AIMessage & { invalid_tool_calls?: unknown }).invalid_tool_calls);
  if (Array.isArray(invalid) && invalid.length > 0) {
    meta.invalid_tool_calls = invalid as MessageSnapshotMeta['invalid_tool_calls'];
  }

  return {
    blocks,
    text: textOf(msg),
    multipart: isArray || toolCalls.length > 0,
    meta,
  };
}

function readSnapshotMeta(metadata: Record<string, unknown> | undefined): MessageSnapshotMeta | undefined {
  if (!metadata || metadata.langchain !== SNAPSHOT_VERSION) return undefined;
  return metadata as unknown as MessageSnapshotMeta;
}

interface RebuiltFields {
  content: string | Array<Record<string, unknown>>;
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown>; type: 'tool_call' }>;
  invalidToolCalls: NonNullable<MessageSnapshotMeta['invalid_tool_calls']>;
  additional_kwargs?: Record<string, unknown>;
  response_metadata?: Record<string, unknown>;
}

/** Rebuild the AIMessage fields from a cache hit; null when the entry is unusable. */
function rebuildFields(cached: LlmCacheResult): RebuiltFields | null {
  if (!cached.hit) return null;
  const meta = readSnapshotMeta(cached.metadata);
  const blocks = cached.contentBlocks;

  if (!blocks && cached.response == null) return null;

  const toolCalls = (blocks ?? [])
    .filter((b): b is ToolCallBlock => b.type === 'tool_call')
    .map((b) => ({
      id: b.id,
      name: b.name,
      args: b.args as Record<string, unknown>,
      type: 'tool_call' as const,
    }));

  const text = blocks
    ? blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('')
    : cached.response ?? '';

  let content: RebuiltFields['content'] = text;
  if (meta?.contentShape === 'array' && blocks) {
    const toolUse = new Set(meta.toolUseIds ?? []);
    const parts: Array<Record<string, unknown>> = [];
    for (const b of blocks) {
      if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'reasoning') {
        parts.push(
          b.redacted
            ? { type: 'redacted_thinking', data: b.opaqueSignature ?? '' }
            : {
                type: 'thinking',
                thinking: b.text,
                ...(b.opaqueSignature !== undefined ? { signature: b.opaqueSignature } : {}),
              },
        );
      } else if (b.type === 'tool_call' && toolUse.has(b.id)) {
        parts.push({ type: 'tool_use', id: b.id, name: b.name, input: b.args });
      }
    }
    content = parts;
  }

  return {
    content,
    text,
    toolCalls,
    invalidToolCalls: meta?.invalid_tool_calls ?? [],
    ...(meta?.additional_kwargs !== undefined ? { additional_kwargs: meta.additional_kwargs } : {}),
    ...(meta?.response_metadata !== undefined ? { response_metadata: meta.response_metadata } : {}),
  };
}

function rebuildGeneration(cached: LlmCacheResult): ChatGeneration | null {
  const f = rebuildFields(cached);
  if (!f) return null;
  const message = new AIMessage({
    content: f.content as AIMessage['content'],
    tool_calls: f.toolCalls,
    invalid_tool_calls: f.invalidToolCalls as AIMessage['invalid_tool_calls'],
    ...(f.additional_kwargs !== undefined ? { additional_kwargs: f.additional_kwargs } : {}),
    ...(f.response_metadata !== undefined ? { response_metadata: f.response_metadata } : {}),
  });
  return { text: f.text, message };
}

/**
 * Streaming replay of a hit as a single chunk. Tool calls are carried as
 * `tool_call_chunks` (from which AIMessageChunk derives `tool_calls`), so
 * LangGraph `streamMode: "messages"` consumers, which render from the chunks,
 * see them. Invalid tool calls are set directly: as chunks, LangChain's partial
 * JSON parser would turn a truncated `{"city":` into a valid `{}` call.
 */
function rebuildChunk(cached: LlmCacheResult): ChatGenerationChunk | null {
  const f = rebuildFields(cached);
  if (!f) return null;
  const toolCallChunks: ToolCallChunk[] = f.toolCalls.map((tc, index) => ({
    id: tc.id,
    name: tc.name,
    args: JSON.stringify(tc.args ?? {}),
    index,
    type: 'tool_call_chunk' as const,
  }));

  const message = new AIMessageChunk({
    content: f.content as AIMessageChunk['content'],
    ...(toolCallChunks.length > 0 ? { tool_call_chunks: toolCallChunks } : {}),
    ...(f.additional_kwargs !== undefined ? { additional_kwargs: f.additional_kwargs } : {}),
    ...(f.response_metadata !== undefined ? { response_metadata: f.response_metadata } : {}),
  });
  if (f.invalidToolCalls.length > 0) {
    message.invalid_tool_calls = f.invalidToolCalls as AIMessageChunk['invalid_tool_calls'];
  }
  return new ChatGenerationChunk({ text: f.text, message });
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
   * Report the wrapped model's LangSmith params (ls_provider, ls_model_name, …)
   * so traces of the wrapper run attribute to the real model.
   */
  getLsParams(options: this['ParsedCallOptions']): ReturnType<BaseChatModel['getLsParams']> {
    try {
      return this.inner.getLsParams(options as never);
    } catch {
      return super.getLsParams(options);
    }
  }

  /**
   * `BaseChatModel.bindTools` has no default implementation, and this dependency
   * line (@langchain/core ^1.1.35) has no `Runnable.bind()` — it was superseded
   * by `withConfig()`. This mirrors what `ChatOpenAI.bindTools` does internally:
   * `bindTools()` → `this.withConfig({ tools })`, which puts `tools` into the
   * call options that `_generate` / `_streamResponseChunks` receive.
   *
   * `kwargs` are carried along so they are re-applied when the raw tools are
   * bound onto the wrapped model (bind-time options such as ChatOpenAI `strict`).
   *
   * Returns a new runnable and does not mutate this instance — the same contract
   * as every other LangChain chat model.
   */
  bindTools(
    tools: unknown[],
    kwargs?: Partial<CachedChatModelCallOptions>,
  ): ReturnType<NonNullable<BaseChatModel['bindTools']>> {
    if (typeof this.inner.bindTools !== 'function') {
      throw new Error(
        `CachedChatModel: the wrapped model (${this.inner._llmType()}) does not implement bindTools().`,
      );
    }
    return this.withConfig({
      ...kwargs,
      tools,
      bindToolsKwargs: { ...kwargs },
    } as Partial<CachedChatModelCallOptions>);
  }

  /**
   * Structured output through the cache, as a forced tool call.
   *
   * The inherited BaseChatModel implementation is not usable here: it binds the
   * schema tool without tool_choice (so the model may answer in prose and the
   * parse fails with "No tool calls found in the response."), and its parser
   * only accepts AIMessageChunk, while _generate returns AIMessage (both on a
   * hit and from most providers on a miss). The wrapped model's own
   * implementation (json_schema for ChatOpenAI, a forced tool for ChatAnthropic)
   * cannot be reused either, because calls must go through this wrapper.
   *
   * So this binds the schema as one tool with tool_choice "any", which LangChain
   * maps per provider (OpenAI "required", Anthropic { type: "any" }, Gemini ANY),
   * and parses with JsonOutputKeyToolsParser, which validates Zod schemas. Under
   * extended thinking the tool is left unforced, because Anthropic rejects a
   * forced tool_choice there (ChatAnthropic does the same).
   *
   * Schemas other than Zod or a plain JSON Schema object, `method: "jsonMode"`
   * and `strict` fall back to the inherited implementation unchanged.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withStructuredOutput(outputSchema: any, config?: any): any {
    const isZod = isInteropZodSchema(outputSchema);
    const isJsonSchemaObject = !isZod && typeof outputSchema === 'object' && outputSchema !== null &&
      !('~standard' in outputSchema);
    if ((!isZod && !isJsonSchemaObject) || config?.method === 'jsonMode' || config?.strict) {
      return super.withStructuredOutput(outputSchema, config);
    }

    // Same tool definition the inherited implementation builds.
    let name: string = config?.name ?? 'extract';
    if (!isZod && typeof outputSchema.name === 'string') name = outputSchema.name;
    const tool = {
      type: 'function' as const,
      function: {
        name,
        description: getSchemaDescription(outputSchema) ?? 'A function available to call.',
        parameters: isZod ? toJsonSchema(outputSchema) : outputSchema,
      },
    };

    const llm = this.bindTools([tool], this.thinkingEnabled() ? {} : { tool_choice: 'any' });
    const parser = new JsonOutputKeyToolsParser({
      keyName: name,
      returnSingle: true,
      ...(isZod ? { zodSchema: outputSchema } : {}),
    });

    if (!config?.includeRaw) {
      return llm.pipe(parser).withConfig({ runName: 'StructuredOutput' });
    }
    const parsed = RunnablePassthrough.assign({
      parsed: (input: { raw: BaseMessage }, runConfig) => parser.invoke(input.raw, runConfig),
    }).withFallbacks({ fallbacks: [RunnablePassthrough.assign({ parsed: () => null })] });
    return RunnableSequence.from([{ raw: llm }, parsed]).withConfig({
      runName: 'StructuredOutputRunnable',
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { tools, bindToolsKwargs, restOptions } = this.splitOptions(options);
    // The wrapped model's run is traced as a child of this one.
    const innerOptions = { ...restOptions, callbacks: childCallbacksOf(runManager) };

    const { tools: convertedTools, complete } = convertTools(tools, options.strict);
    if (!complete) {
      // The key can't represent every bound tool: pass through uncached.
      warnUncacheableTools();
      const result = (await this.bindInner(tools, bindToolsKwargs).invoke(
        messages,
        innerOptions as never,
      )) as AIMessage;
      return { generations: [{ text: textOf(result), message: result }] };
    }
    const params = this.toParams(messages, convertedTools, restOptions);

    try {
      const cached = await this.agentCache.llm.check(params);
      if (cached.hit) {
        const gen = rebuildGeneration(cached);
        if (gen) return { generations: [gen] };
      }
    } catch {
      // never let a cache read break inference
    }

    const innerModel = this.bindInner(tools, bindToolsKwargs);
    const result = (await innerModel.invoke(messages, innerOptions as never)) as AIMessage;

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
   * Token callbacks fire once per token: on a miss the wrapped model's child run
   * emits them (it receives this run's child callbacks), so this run does not
   * re-emit them; on a hit there is no child run and this run emits the replay.
   *
   * Cached streams replay as one chunk — the same trade-off documented for the
   * Vercel AI SDK adapter's `wrapStream`.
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const { tools, bindToolsKwargs, restOptions } = this.splitOptions(options);
    const innerOptions = { ...restOptions, callbacks: childCallbacksOf(runManager) };
    const { tools: convertedTools, complete } = convertTools(tools, options.strict);
    if (!complete) {
      // The key can't represent every bound tool: pass through uncached.
      warnUncacheableTools();
      for await (const chunk of await this.bindInner(tools, bindToolsKwargs).stream(
        messages,
        innerOptions as never,
      )) {
        const messageChunk = chunk as AIMessageChunk;
        yield new ChatGenerationChunk({ text: textOfContent(messageChunk.content), message: messageChunk });
      }
      return;
    }
    const params = this.toParams(messages, convertedTools, restOptions);

    // ── hit: replay, skip the model ────────────────────────────────────────
    try {
      const cached = await this.agentCache.llm.check(params);
      if (cached.hit) {
        const chunk = rebuildChunk(cached);
        if (chunk) {
          await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, {
            chunk,
          });
          yield chunk;
          return;
        }
      }
    } catch {
      // never let a cache read break inference
    }

    // ── miss: pass through, accumulate, store on completion ────────────────
    const innerModel = this.bindInner(tools, bindToolsKwargs);
    let aggregate: AIMessageChunk | undefined;

    for await (const chunk of await innerModel.stream(messages, innerOptions as never)) {
      const messageChunk = chunk as AIMessageChunk;
      aggregate = aggregate === undefined ? messageChunk : concat(aggregate, messageChunk);
      yield new ChatGenerationChunk({ text: textOfContent(messageChunk.content), message: messageChunk });
    }

    if (aggregate !== undefined) {
      try {
        await this.persist(params, aggregate as unknown as AIMessage);
      } catch {
        // fail-open: the stream was already delivered in full
      }
    }
  }

  /**
   * Separate the cache-key tools and bind kwargs from the options forwarded to
   * the wrapped model. `tools` is stripped because the raw tools are bound onto
   * the inner model in provider-formatted form (bindInner); forwarding them here
   * would overwrite that.
   */
  private splitOptions(options: CachedChatModelCallOptions): {
    tools: unknown[] | undefined;
    bindToolsKwargs: Record<string, unknown> | undefined;
    restOptions: Record<string, unknown>;
  } {
    const { tools, bindToolsKwargs, ...restOptions } = options as CachedChatModelCallOptions &
      Record<string, unknown>;
    return { tools, bindToolsKwargs, restOptions };
  }

  private toParams(
    messages: BaseMessage[],
    converted: LlmCacheParams['tools'] | undefined,
    callOptions: Record<string, unknown>,
  ): LlmCacheParams {
    const params: LlmCacheParams = {
      model: this.modelNameOverride ?? modelNameOf(this.inner),
      messages: messages.map(convertMessage),
    };

    if (converted && converted.length > 0) params.tools = converted;

    if (callOptions.tool_choice !== undefined) params.toolChoice = callOptions.tool_choice;

    // Key on the wrapped model's full invocation params (constructor settings
    // merged with call options), minus transport/runtime keys. Params with a
    // first-class LlmCacheParams field are mapped onto it, consistent with the
    // openai-chat and anthropic adapters; everything else goes into
    // providerParams so e.g. response_format, parallel_tool_calls, top_k,
    // thinking and max_completion_tokens all separate entries.
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.readInvocationParams(callOptions))) {
      if (v === undefined || v === null || INVOCATION_PARAMS_DENYLIST.has(k)) continue;
      rest[k] = v;
    }
    const take = (k: string): unknown => {
      const v = rest[k];
      delete rest[k];
      return v;
    };

    if (typeof rest.temperature === 'number') params.temperature = take('temperature') as number;
    if (typeof rest.top_p === 'number') params.top_p = take('top_p') as number;
    if (typeof rest.max_tokens === 'number') params.max_tokens = take('max_tokens') as number;
    if (typeof rest.seed === 'number') params.seed = take('seed') as number;

    // stop (OpenAI) and stop_sequences (Anthropic) both map to `stop`, as the
    // anthropic adapter does.
    const stop = Array.isArray(rest.stop) ? rest.stop
      : typeof rest.stop === 'string' ? [rest.stop]
      : Array.isArray(rest.stop_sequences) ? rest.stop_sequences
      : undefined;
    if (stop && stop.length > 0 && stop.every((s) => typeof s === 'string')) {
      params.stop = stop as string[];
      delete rest.stop;
      delete rest.stop_sequences;
    }

    if (rest.response_format !== undefined) params.responseFormat = take('response_format');
    if (typeof rest.reasoning_effort === 'string') params.reasoningEffort = take('reasoning_effort') as string;
    if (typeof rest.prompt_cache_key === 'string') params.promptCacheKey = take('prompt_cache_key') as string;

    const providerParams = toJsonSafe(rest);
    if (isNonEmptyObject(providerParams)) params.providerParams = providerParams;

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

  private thinkingEnabled(): boolean {
    const thinking = this.readInvocationParams({}).thinking as { type?: unknown } | undefined;
    return typeof thinking?.type === 'string' && THINKING_ON.has(thinking.type);
  }

  /**
   * CachedChatModel owns cache keying (canonical JSON Schema); the inner model
   * owns provider-specific wire formatting. Re-bind the raw tools onto the inner
   * model, with the original bindTools kwargs, so it formats and sends them itself.
   */
  private bindInner(
    tools: unknown[] | undefined,
    kwargs: Record<string, unknown> | undefined,
  ): BaseChatModel | ReturnType<NonNullable<BaseChatModel['bindTools']>> {
    if (!tools || tools.length === 0) return this.inner;
    if (typeof this.inner.bindTools !== 'function') {
      // Never send a request without the tools the cache key was built from.
      throw new Error(
        `CachedChatModel: the wrapped model (${this.inner._llmType()}) does not implement bindTools().`,
      );
    }
    return this.inner.bindTools(tools as never, kwargs as never);
  }

  private async persist(params: LlmCacheParams, msg: AIMessage): Promise<void> {
    const snapshot = snapshotMessage(msg);
    if (!snapshot) return; // not faithfully replayable: serve it, don't cache it
    const tokens = tokensOf(msg);
    const options = {
      ...(tokens ? { tokens } : {}),
      metadata: snapshot.meta as unknown as Record<string, unknown>,
    };
    if (snapshot.multipart) {
      await this.agentCache.llm.storeMultipart(params, snapshot.blocks, options);
    } else {
      await this.agentCache.llm.store(params, snapshot.text, options);
    }
  }
}

/**
 * Callbacks for the wrapped model's run, parented to this run.
 *
 * CallbackManagerForLLMRun has no getChild() (only chain/tool/retriever run
 * managers do), so this mirrors CallbackManagerForChainRun.getChild(): a new
 * manager whose parent is this run, carrying the inheritable handlers, tags and
 * metadata.
 *
 * Inheritable handlers get the wrapped model's tokens from its child run, so
 * this run does not re-emit them (each token would be reported twice).
 * Non-inherited handlers of this run, such as `callbacks` passed to the
 * CachedChatModel constructor, never see the child run, so a LocalTokenRelay is
 * added (non-inheritable) to forward each token to them as this run's token.
 * Every handler therefore sees each token exactly once, on a miss and on a hit.
 */
function childCallbacksOf(runManager: CallbackManagerForLLMRun | undefined): CallbackManager | undefined {
  if (!runManager) return undefined;
  // These fields are protected on BaseRunManager (getChild() reads them from inside the class).
  const rm = runManager as unknown as {
    runId: string;
    parentRunId?: string;
    handlers: CallbackManager['handlers'];
    inheritableHandlers: CallbackManager['handlers'];
    tags: string[];
    inheritableTags: string[];
    metadata: Record<string, unknown>;
    inheritableMetadata: Record<string, unknown>;
  };
  const manager = new CallbackManager(rm.runId);
  manager.setHandlers(rm.inheritableHandlers);
  manager.addTags(rm.inheritableTags);
  manager.addMetadata(rm.inheritableMetadata);

  const localHandlers = rm.handlers.filter((h) => !rm.inheritableHandlers.includes(h));
  if (localHandlers.length > 0) {
    const localRun = new CallbackManagerForLLMRun(
      rm.runId,
      localHandlers,
      [],
      rm.tags,
      [],
      rm.metadata,
      {},
      rm.parentRunId,
    );
    manager.addHandler(
      new LocalTokenRelay({
        target: localRun,
        raiseError: localHandlers.some((h) => h.raiseError),
        awaitHandlers: localHandlers.some((h) => h.awaitHandlers),
      }),
      false,
    );
  }
  return manager;
}

/**
 * Forwards the wrapped model's tokens to this run's non-inherited handlers,
 * reported under this run's id. Only handleLLMNewToken is implemented, so those
 * handlers still see a single LLM run (this one), never the child run.
 */
class LocalTokenRelay extends BaseCallbackHandler {
  name = 'betterdb_cached_chat_model_token_relay';

  private readonly target: CallbackManagerForLLMRun;

  // BaseCallbackHandler.copy() calls `new this.constructor(this)`, so the
  // constructor reads only fields that exist on an instance.
  constructor(input: { target: CallbackManagerForLLMRun; raiseError: boolean; awaitHandlers: boolean }) {
    super({ raiseError: input.raiseError, _awaitHandler: input.awaitHandlers });
    this.target = input.target;
  }

  async handleLLMNewToken(
    token: string,
    idx: NewTokenIndices,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    fields?: HandleLLMNewTokenCallbackFields,
  ): Promise<void> {
    await this.target.handleLLMNewToken(token, idx, undefined, undefined, undefined, fields);
  }
}

function warnUncacheableTools(): void {
  if (warnedUncacheableTools) return;
  warnedUncacheableTools = true;
  console.warn(
    '[@betterdb/agent-cache] CachedChatModel: a bound tool could not be converted to a ' +
      'JSON-schema cache key (e.g. a provider built-in or server tool), so calls with it ' +
      'bypass the cache. This warning is shown once per process.',
  );
}
