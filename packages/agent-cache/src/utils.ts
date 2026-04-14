import { createHash } from 'node:crypto';
import { AgentCacheUsageError } from './errors';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Glob metacharacters that need escaping in SCAN MATCH patterns
const GLOB_METACHAR_PATTERN = /[*?[\]]/;

/**
 * Escape glob metacharacters for use in SCAN MATCH patterns.
 */
export function escapeGlobPattern(str: string): string {
  return str.replace(/([*?[\]])/g, '\\$1');
}

/**
 * Validate that a string doesn't contain glob metacharacters.
 * Throws AgentCacheUsageError if it does.
 */
export function validateNoGlobChars(value: string, name: string): void {
  if (GLOB_METACHAR_PATTERN.test(value)) {
    throw new AgentCacheUsageError(
      `${name} contains glob metacharacters (*, ?, [, ]). ` +
      `This is not allowed as it could match unintended keys.`
    );
  }
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
 * Build the LLM cache key hash. Canonical form:
 * { model, messages (as-is), temperature (default 1), top_p (default 1), max_tokens, tools (sorted by function.name) }
 */
export function llmCacheHash(params: {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: Array<{ type: string; function: { name: string; [key: string]: unknown } }>;
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
  });

  return sha256(canonical);
}

/**
 * Build the tool cache key hash. Canonical JSON of args with sorted keys.
 */
export function toolCacheHash(args: unknown): string {
  return sha256(canonicalJson(args ?? {}));
}
