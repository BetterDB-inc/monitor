/**
 * Anthropic Messages API adapter for @betterdb/semantic-cache.
 *
 * Extracts the text to embed from Anthropic Messages API request params.
 * Semantic caching keys on the last user message's text content because that
 * is the actual query. See openai.ts for the full rationale.
 *
 * Usage:
 *   import { prepareSemanticParams } from '@betterdb/semantic-cache/anthropic';
 *   const { text, model } = await prepareSemanticParams(params);
 *   const result = await cache.check(text);
 */
import type {
  MessageCreateParamsNonStreaming,
  ContentBlockParam,
  TextBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
} from '@anthropic-ai/sdk/resources';
import type { BinaryBlock, TextBlock } from '../utils';
import type { BinaryNormalizer, BinaryRef } from '../normalizer';
import { defaultNormalizer } from '../normalizer';

export interface AnthropicSemanticPrepareOptions {
  /** Binary content normalizer. Default: passthrough. */
  normalizer?: BinaryNormalizer;
}

export interface SemanticParams {
  text: string;
  blocks?: (TextBlock | BinaryBlock)[];
  model?: string;
}

async function normalizeBlock(
  block: ContentBlockParam,
  normalizer: BinaryNormalizer,
): Promise<TextBlock | BinaryBlock | null> {
  const type = (block as { type: string }).type;

  if (type === 'text') {
    const b = block as TextBlockParam;
    return { type: 'text', text: b.text };
  }

  if (type === 'image') {
    const b = block as ImageBlockParam;
    const src = b.source as { type: string; data?: string; media_type?: string; url?: string; file_id?: string };
    let source: BinaryRef['source'];
    let mediaType = 'image/*';

    if (src.type === 'base64') {
      source = { type: 'base64', data: src.data! };
      mediaType = src.media_type ?? 'image/*';
    } else if (src.type === 'url') {
      source = { type: 'url', url: src.url! };
    } else if (src.type === 'file') {
      source = { type: 'fileId', fileId: src.file_id!, provider: 'anthropic' };
    } else {
      return null;
    }

    const ref = await normalizer({ kind: 'image', source });
    return { type: 'binary', kind: 'image', mediaType, ref };
  }

  if (type === 'document') {
    const b = block as DocumentBlockParam;
    const src = b.source as {
      type: string;
      data?: string;
      text?: string;
      media_type?: string;
      url?: string;
      file_id?: string;
    };

    let source: BinaryRef['source'];
    let mediaType = 'application/octet-stream';

    if (src.type === 'base64') {
      source = { type: 'base64', data: src.data! };
      mediaType = src.media_type ?? 'application/pdf';
    } else if (src.type === 'text') {
      const encoded = Buffer.from(src.text!).toString('base64');
      source = { type: 'base64', data: encoded };
      mediaType = 'text/plain';
    } else if (src.type === 'url') {
      source = { type: 'url', url: src.url! };
      mediaType = 'application/pdf';
    } else if (src.type === 'file') {
      source = { type: 'fileId', fileId: src.file_id!, provider: 'anthropic' };
    } else {
      return null;
    }

    const ref = await normalizer({ kind: 'document', source });
    return { type: 'binary', kind: 'document', mediaType, ref };
  }

  return null;
}

/**
 * Extract semantic cache params from Anthropic Messages API request params.
 *
 * Extracts the last user message text for semantic similarity matching.
 * The system prompt is not included in the cache key because it rarely changes
 * within a deployment and would prevent hits across conversations.
 */
export async function prepareSemanticParams(
  params: MessageCreateParamsNonStreaming,
  opts?: AnthropicSemanticPrepareOptions,
): Promise<SemanticParams> {
  const normalizer = opts?.normalizer ?? defaultNormalizer;

  // Find last user message
  const userMessages = params.messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    return { text: '', model: params.model };
  }

  const lastUser = userMessages[userMessages.length - 1];
  const content = lastUser.content;

  if (typeof content === 'string') {
    return { text: content, model: params.model };
  }

  if (Array.isArray(content)) {
    const blocks: (TextBlock | BinaryBlock)[] = [];
    for (const part of content as ContentBlockParam[]) {
      const block = await normalizeBlock(part, normalizer);
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
