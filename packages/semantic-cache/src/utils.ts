import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export { escapeTag, encodeFloat32, parseFtSearchResponse } from '@betterdb/valkey-search-kit';

// --- Content block types (mirrors agent-cache for cross-package compatibility) ---

export type ContentBlock =
  | TextBlock
  | BinaryBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningBlock;

export interface TextBlock {
  type: 'text';
  text: string;
  hints?: BlockHints;
}

export interface BinaryBlock {
  type: 'binary';
  kind: 'image' | 'audio' | 'document';
  mediaType: string;
  ref: string;
  detail?: 'auto' | 'low' | 'high' | 'original';
  filename?: string;
  hints?: BlockHints;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  args: unknown;
  hints?: BlockHints;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: Array<TextBlock | BinaryBlock>;
  isError?: boolean;
  hints?: BlockHints;
}

export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
  opaqueSignature?: string;
  redacted?: boolean;
  hints?: BlockHints;
}

export interface BlockHints {
  anthropicCacheControl?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
  [k: string]: unknown;
}

/**
 * Extract all text from a ContentBlock array, joining TextBlock.text values with a space.
 * Used to derive the embedding text from a multi-modal prompt.
 */
export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/**
 * Extract all binary refs from a ContentBlock array, sorted for stability.
 * Used for the binary_refs TAG field on cache entries.
 */
export function extractBinaryRefs(blocks: ContentBlock[]): string[] {
  return blocks
    .filter((b): b is BinaryBlock => b.type === 'binary')
    .map((b) => b.ref)
    .sort();
}
