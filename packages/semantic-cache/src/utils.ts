import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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

/**
 * Encode number[] as a little-endian Float32 Buffer.
 * Used to store embeddings as binary HSET field values.
 */
export function encodeFloat32(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

/**
 * Parse a raw FT.SEARCH response from iovalkey's client.call().
 *
 * iovalkey returns FT.SEARCH results in the following shape:
 *   [totalCount, key1, [field1, val1, field2, val2, ...], key2, [...], ...]
 *
 * - totalCount is a string (e.g. "2")
 * - Each key is a string
 * - Each field list is a flat string array: [fieldName, value, fieldName, value, ...]
 *
 * Returns an array of { key: string, fields: Record<string, string> }.
 * Returns [] if totalCount is "0" or the response is empty/malformed.
 * Never throws — on any parse error, returns [].
 */
export function parseFtSearchResponse(
  raw: unknown,
): Array<{ key: string; fields: Record<string, string> }> {
  try {
    if (!Array.isArray(raw) || raw.length < 1) {
      return [];
    }

    const totalCount = typeof raw[0] === 'string' ? parseInt(raw[0], 10) : Number(raw[0]);
    if (!totalCount || totalCount <= 0) {
      return [];
    }

    const results: Array<{ key: string; fields: Record<string, string> }> = [];

    let i = 1;
    while (i < raw.length) {
      const key = raw[i];
      if (typeof key !== 'string') {
        i++;
        continue;
      }

      const fieldList = raw[i + 1];
      const fields: Record<string, string> = {};

      if (Array.isArray(fieldList)) {
        const len = fieldList.length - (fieldList.length % 2);
        for (let j = 0; j < len; j += 2) {
          const fieldName = String(fieldList[j]);
          const fieldValue = String(fieldList[j + 1]);
          fields[fieldName] = fieldValue;
        }
        i += 2;
      } else {
        // No field list follows the key (e.g. RETURN 0 mode)
        results.push({ key, fields });
        i++;
        continue;
      }

      results.push({ key, fields });
    }

    return results;
  } catch {
    return [];
  }
}
