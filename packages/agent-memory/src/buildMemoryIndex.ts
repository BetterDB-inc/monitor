import { VECTOR_FIELD } from './buildRecallQuery';

export const MEMORY_INDEX_ALGORITHM = 'HNSW';

export function memoryIndexName(name: string): string {
  return `${name}:mem:idx`;
}

export function memoryKeyPrefix(name: string): string {
  return `${name}:mem:`;
}

export function buildMemoryIndexArgs(name: string, dims: number): string[] {
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`memory index dimension must be a positive integer, got: ${dims}`);
  }
  return [
    memoryIndexName(name),
    'ON',
    'HASH',
    'PREFIX',
    '1',
    memoryKeyPrefix(name),
    'SCHEMA',
    VECTOR_FIELD,
    'VECTOR',
    MEMORY_INDEX_ALGORITHM,
    '6',
    'TYPE',
    'FLOAT32',
    'DIM',
    String(dims),
    'DISTANCE_METRIC',
    'COSINE',
    'threadId',
    'TAG',
    'agentId',
    'TAG',
    'namespace',
    'TAG',
    'tags',
    'TAG',
    'SEPARATOR',
    ',',
    'source',
    'TAG',
    'importance',
    'NUMERIC',
    'created_at',
    'NUMERIC',
    'last_accessed_at',
    'NUMERIC',
    'access_count',
    'NUMERIC',
    'content',
    'TEXT',
  ];
}
