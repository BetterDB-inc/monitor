/**
 * OpenAI Responses API adapter for @betterdb/semantic-cache.
 *
 * Extracts the text to embed from OpenAI Responses API request params.
 * Semantic caching keys on the last user input text. See openai.ts for
 * the rationale for keying on the last user message rather than full history.
 *
 * Usage:
 *   import { prepareSemanticParams } from '@betterdb/semantic-cache/openai-responses';
 *   const { text, model } = await prepareSemanticParams(params);
 *   const result = await cache.check(text);
 */
import type { ResponseCreateParams } from 'openai/resources/responses/responses';
import type { BinaryBlock, TextBlock } from '../utils';
import type { BinaryNormalizer, BinaryRef } from '../normalizer';
import { defaultNormalizer } from '../normalizer';

export interface OpenAIResponsesSemanticPrepareOptions {
  /** Binary content normalizer. Default: passthrough. */
  normalizer?: BinaryNormalizer;
}

export interface SemanticParams {
  text: string;
  blocks?: (TextBlock | BinaryBlock)[];
  model?: string;
}

type AnyItem = { type?: string; role?: string; [k: string]: unknown };

async function normalizeResponsesPart(
  part: AnyItem,
  normalizer: BinaryNormalizer,
): Promise<TextBlock | BinaryBlock | null> {
  const t = part.type as string | undefined;

  if (t === 'input_text' || t === 'output_text') {
    return { type: 'text', text: (part.text as string) ?? '' };
  }

  if (t === 'input_image') {
    const fileId = part.file_id as string | null | undefined;
    const imageUrl = part.image_url as string | null | undefined;
    const detail = part.detail as BinaryBlock['detail'] | undefined;

    let source: BinaryRef['source'];
    let mediaType = 'image/*';

    if (fileId) {
      source = { type: 'fileId', fileId, provider: 'openai' };
    } else if (imageUrl) {
      if (imageUrl.startsWith('data:')) {
        const semi = imageUrl.indexOf(';');
        if (semi > 5) mediaType = imageUrl.slice(5, semi);
        source = { type: 'base64', data: imageUrl };
      } else {
        source = { type: 'url', url: imageUrl };
      }
    } else {
      return null;
    }

    const ref = await normalizer({ kind: 'image', source });
    const block: BinaryBlock = { type: 'binary', kind: 'image', mediaType, ref };
    if (detail) block.detail = detail;
    return block;
  }

  if (t === 'input_file') {
    const fileId = part.file_id as string | null | undefined;
    const fileData = part.file_data as string | null | undefined;
    const fileUrl = part.file_url as string | null | undefined;
    const filename = part.filename as string | null | undefined;

    let source: BinaryRef['source'];
    let mediaType = 'application/octet-stream';

    if (fileId) {
      source = { type: 'fileId', fileId, provider: 'openai' };
    } else if (fileData) {
      if (fileData.startsWith('data:')) {
        const semi = fileData.indexOf(';');
        if (semi > 5) mediaType = fileData.slice(5, semi);
      }
      source = { type: 'base64', data: fileData };
    } else if (fileUrl) {
      source = { type: 'url', url: fileUrl };
    } else {
      return null;
    }

    const ref = await normalizer({ kind: 'document', source });
    const block: BinaryBlock = { type: 'binary', kind: 'document', mediaType, ref };
    if (filename) block.filename = filename;
    return block;
  }

  return null;
}

/**
 * Extract semantic cache params from OpenAI Responses API request params.
 *
 * Extracts the last user input text (or the instructions if no user input exists)
 * for semantic similarity matching.
 */
export async function prepareSemanticParams(
  params: ResponseCreateParams,
  opts?: OpenAIResponsesSemanticPrepareOptions,
): Promise<SemanticParams> {
  const normalizer = opts?.normalizer ?? defaultNormalizer;
  const p = params as {
    instructions?: string | null;
    input?: string | unknown[];
    model: string;
  };

  if (typeof p.input === 'string') {
    return { text: p.input, model: p.model };
  }

  if (Array.isArray(p.input)) {
    // Find last user/message input item
    const userItems = (p.input as AnyItem[]).filter(
      (item) => !item.role || item.role === 'user' || item.type === 'message',
    );
    const lastUser = userItems[userItems.length - 1];

    if (lastUser) {
      const content = lastUser.content;
      if (typeof content === 'string') {
        return { text: content, model: p.model };
      }
      if (Array.isArray(content)) {
        const blocks: (TextBlock | BinaryBlock)[] = [];
        for (const part of content as AnyItem[]) {
          const block = await normalizeResponsesPart(part, normalizer);
          if (block) blocks.push(block);
        }
        const text = blocks
          .filter((b): b is TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ');
        return { text, blocks, model: p.model };
      }
    }
  }

  // Fall back to instructions
  if (p.instructions) {
    return { text: p.instructions, model: p.model };
  }

  return { text: '', model: p.model };
}
