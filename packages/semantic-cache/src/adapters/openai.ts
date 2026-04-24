/**
 * OpenAI Chat Completions adapter for @betterdb/semantic-cache.
 *
 * Extracts the text to embed from OpenAI Chat Completions request params.
 * Semantic caching keys on the last user message's text content because that
 * is the actual query that changes between requests. Caching on the full
 * conversation history would produce almost no hits in practice since each
 * conversation turn is unique. Use the filter option on check() to scope
 * results to a specific model or conversation context if needed.
 *
 * Usage:
 *   import { prepareSemanticParams } from '@betterdb/semantic-cache/openai';
 *   const { text, model } = await prepareSemanticParams(params);
 *   const result = await cache.check(text, { filter: `@model:{${model}}` });
 */
import type {
  ChatCompletionCreateParams,
  ChatCompletionContentPart,
} from 'openai/resources/chat/completions';
import type { BinaryBlock, TextBlock } from '../utils';
import type { BinaryNormalizer, BinaryRef } from '../normalizer';
import { defaultNormalizer } from '../normalizer';

export interface OpenAISemanticPrepareOptions {
  /** Binary content normalizer. Default: passthrough. */
  normalizer?: BinaryNormalizer;
}

export interface SemanticParams {
  /**
   * The extracted text to embed. Pass to cache.check(text) or cache.store(text, response).
   */
  text: string;
  /**
   * Content blocks extracted from the last user message.
   * Present when the message contains multi-part content (text + images/files).
   * Pass to cache.check(blocks) for binary-aware cache lookups.
   */
  blocks?: (TextBlock | BinaryBlock)[];
  /** Model name from the request params. Use as a TAG filter if desired. */
  model?: string;
}

async function normalizeContentPart(
  part: ChatCompletionContentPart,
  normalizer: BinaryNormalizer,
): Promise<TextBlock | BinaryBlock | null> {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image_url') {
    const url = part.image_url.url;
    let source: BinaryRef['source'];
    let mediaType = 'image/*';
    if (url.startsWith('data:')) {
      const semi = url.indexOf(';');
      if (semi > 5) mediaType = url.slice(5, semi);
      source = { type: 'base64', data: url };
    } else {
      source = { type: 'url', url };
    }
    const ref = await normalizer({ kind: 'image', source });
    const block: BinaryBlock = { type: 'binary', kind: 'image', mediaType, ref };
    if (part.image_url.detail) block.detail = part.image_url.detail;
    return block;
  }
  if (part.type === 'input_audio') {
    const ref = await normalizer({
      kind: 'audio',
      source: { type: 'base64', data: part.input_audio.data },
    });
    return {
      type: 'binary',
      kind: 'audio',
      mediaType: `audio/${part.input_audio.format}`,
      ref,
    };
  }
  if (part.type === 'file') {
    const { file_id, file_data, filename } = part.file;
    let source: BinaryRef['source'];
    let mediaType = 'application/octet-stream';
    if (file_id) {
      source = { type: 'fileId', fileId: file_id, provider: 'openai' };
    } else if (file_data) {
      if (file_data.startsWith('data:')) {
        const semi = file_data.indexOf(';');
        if (semi > 5) mediaType = file_data.slice(5, semi);
      }
      source = { type: 'base64', data: file_data };
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
 * Extract semantic cache params from OpenAI Chat Completions request params.
 *
 * Extracts the last user message for semantic similarity matching.
 */
export async function prepareSemanticParams(
  params: ChatCompletionCreateParams,
  opts?: OpenAISemanticPrepareOptions,
): Promise<SemanticParams> {
  const normalizer = opts?.normalizer ?? defaultNormalizer;

  // Find last user message
  const userMessages = params.messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    return { text: '', model: params.model };
  }

  const lastUser = userMessages[userMessages.length - 1];
  const content = (lastUser as { content: string | ChatCompletionContentPart[] }).content;

  if (typeof content === 'string') {
    return { text: content, model: params.model };
  }

  if (Array.isArray(content)) {
    const blocks: (TextBlock | BinaryBlock)[] = [];
    for (const part of content) {
      const block = await normalizeContentPart(part as ChatCompletionContentPart, normalizer);
      if (block) blocks.push(block);
    }
    const text = blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    return { text, blocks, model: params.model };
  }

  return { text: '', model: params.model };
}
