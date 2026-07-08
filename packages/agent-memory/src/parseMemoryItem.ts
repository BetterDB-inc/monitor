import type { FtSearchHit } from '@betterdb/valkey-search-kit';
import type { MemoryItem } from './types';

export function parseMemoryItem(name: string, hit: FtSearchHit): MemoryItem {
  const prefix = `${name}:mem:`;
  let id = hit.key;
  if (hit.key.startsWith(prefix)) {
    id = hit.key.slice(prefix.length);
  }

  const fields = hit.fields;
  const item: MemoryItem = {
    id,
    content: fields.content ?? '',
    importance: parseFloat(fields.importance ?? '0'),
    tags: fields.tags ? fields.tags.split(',') : [],
    createdAt: parseInt(fields.created_at ?? '0', 10),
    lastAccessedAt: parseInt(fields.last_accessed_at ?? '0', 10),
    accessCount: parseInt(fields.access_count ?? '0', 10),
  };

  if (fields.source !== undefined) {
    item.source = fields.source;
  }
  if (fields.subject !== undefined) {
    item.subject = fields.subject;
  }
  if (fields.date !== undefined) {
    item.date = fields.date;
  }
  if (fields.threadId !== undefined) {
    item.threadId = fields.threadId;
  }
  if (fields.agentId !== undefined) {
    item.agentId = fields.agentId;
  }
  if (fields.namespace !== undefined) {
    item.namespace = fields.namespace;
  }

  return item;
}
