/**
 * LlamaIndex adapter for @betterdb/semantic-cache.
 *
 * Extracts the text to embed from LlamaIndex ChatMessage arrays.
 * Semantic caching keys on the last user message's text content.
 * See openai.ts for the full rationale.
 *
 * Usage:
 *   import { prepareSemanticParams } from '@betterdb/semantic-cache/llamaindex';
 *   const { text, model } = prepareSemanticParams(messages, { model: 'gpt-4o' });
 *   const result = await cache.check(text);
 */
import type { ChatMessage } from '@llamaindex/core/llms';
import type { BinaryBlock, TextBlock } from '../utils';
import type { BinaryNormalizer, BinaryRef } from '../normalizer';
import { defaultNormalizer } from '../normalizer';

export interface LlamaIndexSemanticPrepareOptions {
  /** Model name to include in the returned SemanticParams. */
  model?: string;
  /** Binary content normalizer. Default: passthrough. */
  normalizer?: BinaryNormalizer;
}

export interface SemanticParams {
  text: string;
  blocks?: (TextBlock | BinaryBlock)[];
  model?: string;
}

type AnyDetail = {
  type: string;
  text?: string;
  image_url?: { url: string };
  data?: string;
  mimeType?: string;
};

async function normalizeDetail(
  part: AnyDetail,
  normalizer: BinaryNormalizer,
): Promise<TextBlock | BinaryBlock | null> {
  if (part.type === 'text') {
    return { type: 'text', text: part.text ?? '' };
  }

  if (part.type === 'image_url' && part.image_url) {
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
    return { type: 'binary', kind: 'image', mediaType, ref };
  }

  if (part.type === 'file' && part.data) {
    const ref = await normalizer({ kind: 'document', source: { type: 'base64', data: part.data } });
    return {
      type: 'binary',
      kind: 'document',
      mediaType: part.mimeType ?? 'application/octet-stream',
      ref,
    };
  }

  if ((part.type === 'audio' || part.type === 'image') && part.data) {
    const kind = part.type === 'audio' ? ('audio' as const) : ('image' as const);
    const ref = await normalizer({ kind, source: { type: 'base64', data: part.data } });
    return {
      type: 'binary',
      kind,
      mediaType: part.mimeType ?? (kind === 'audio' ? 'audio/*' : 'image/*'),
      ref,
    };
  }

  return null;
}

/**
 * Extract semantic cache params from a LlamaIndex ChatMessage array.
 *
 * Extracts the last user message for semantic similarity matching.
 */
export async function prepareSemanticParams(
  messages: ChatMessage[],
  opts?: LlamaIndexSemanticPrepareOptions,
): Promise<SemanticParams> {
  const normalizer = opts?.normalizer ?? defaultNormalizer;

  // Find last user message
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    return { text: '', model: opts?.model };
  }

  const lastUser = userMessages[userMessages.length - 1];

  if (typeof lastUser.content === 'string') {
    return { text: lastUser.content, model: opts?.model };
  }

  if (Array.isArray(lastUser.content)) {
    const blocks: (TextBlock | BinaryBlock)[] = [];
    for (const part of lastUser.content as AnyDetail[]) {
      const block = await normalizeDetail(part, normalizer);
      if (block) blocks.push(block);
    }
    const text = blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    return { text, blocks, model: opts?.model };
  }

  return { text: '', model: opts?.model };
}
