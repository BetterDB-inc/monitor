import { createHash } from 'node:crypto';

export type ContentBlock =
  | TextBlock
  | BinaryBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningBlock;

export interface TextBlock {
  type: "text";
  text: string;
  hints?: BlockHints;
}

export interface BinaryBlock {
  type: "binary";
  kind: "image" | "audio" | "document";
  mediaType: string;
  ref: string;
  detail?: "auto" | "low" | "high" | "original";
  filename?: string;
  hints?: BlockHints;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  args: unknown;
  hints?: BlockHints;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  content: Array<TextBlock | BinaryBlock>;
  isError?: boolean;
  hints?: BlockHints;
}

export interface ReasoningBlock {
  type: "reasoning";
  text: string;
  opaqueSignature?: string;
  redacted?: boolean;
  hints?: BlockHints;
}

export interface BlockHints {
  anthropicCacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" };
  [k: string]: unknown;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Escape glob metacharacters for use in SCAN MATCH patterns.
 * Backslash is escaped first so that subsequent replacements don't double-escape.
 */
export function escapeGlobPattern(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/([*?[\]])/g, '\\$1');
}

/**
 * Serialize an object with sorted keys for deterministic hashing.
 * Handles nested objects. Arrays preserve order (element order matters).
 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, k) => {
        sorted[k] = (value as Record<string, unknown>)[k];
        return sorted;
      }, {});
    }
    return value;
  });
}

/**
 * Build the LLM cache key hash. Canonical form includes all cache-relevant
 * parameters. Undefined fields are dropped by JSON.stringify, preserving
 * byte-identical output for text-only callers (v0.2.0 backward compatibility).
 */
export function llmCacheHash(params: {
  model: string;
  messages: Array<{
    role: string;
    content: unknown;
    toolCallId?: string;
    name?: string;
  }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: Array<{ type: string; function: { name: string; [key: string]: unknown } }>;
  toolChoice?: unknown;
  seed?: number;
  stop?: string[];
  responseFormat?: unknown;
  reasoningEffort?: string;
  promptCacheKey?: string;
}): string {
  const tools = params.tools
    ? [...params.tools].sort((a, b) => a.function.name.localeCompare(b.function.name))
    : undefined;

  const canonical = canonicalJson({
    model: params.model,
    messages: params.messages,
    temperature: params.temperature ?? 1,
    top_p: params.top_p ?? 1,
    max_tokens: params.max_tokens,
    tools,
    toolChoice: params.toolChoice,
    seed: params.seed,
    stop: params.stop,
    responseFormat: params.responseFormat,
    reasoningEffort: params.reasoningEffort,
    promptCacheKey: params.promptCacheKey,
  });

  return sha256(canonical);
}

/**
 * Build the tool cache key hash. Canonical JSON of args with sorted keys.
 */
export function toolCacheHash(args: unknown): string {
  return sha256(canonicalJson(args ?? {}));
}
