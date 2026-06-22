import { encodeFloat32 } from '@betterdb/valkey-search-kit';
import type { RememberOptions } from './types';

export interface MemoryWrite {
  key: string;
  fields: (string | Buffer)[];
}

const DEFAULT_IMPORTANCE = 0.5;

export function buildMemoryRecord(
  name: string,
  id: string,
  content: string,
  vector: number[],
  options: RememberOptions,
  now: number,
): MemoryWrite {
  const importance = options.importance ?? DEFAULT_IMPORTANCE;
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
    throw new Error(
      `importance must be a finite number in [0, 1], got: ${String(options.importance)}`,
    );
  }

  const fields: (string | Buffer)[] = [
    'content',
    content,
    'vector',
    encodeFloat32(vector),
    'importance',
    String(importance),
    'created_at',
    String(now),
    'last_accessed_at',
    String(now),
    'access_count',
    '0',
  ];

  const tags = options.tags ?? [];
  for (const tag of tags) {
    if (tag.includes(',')) {
      throw new Error(`Tag '${tag}' must not contain a comma; tags are stored comma-separated`);
    }
  }
  if (tags.length > 0) {
    fields.push('tags', tags.join(','));
  }

  if (options.threadId !== undefined) {
    fields.push('threadId', options.threadId);
  }
  if (options.agentId !== undefined) {
    fields.push('agentId', options.agentId);
  }
  if (options.namespace !== undefined) {
    fields.push('namespace', options.namespace);
  }
  if (options.source !== undefined) {
    fields.push('source', options.source);
  }

  return { key: `${name}:mem:${id}`, fields };
}
