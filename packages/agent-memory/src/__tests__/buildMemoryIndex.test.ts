import { describe, it, expect } from 'vitest';
import {
  buildMemoryIndexArgs,
  memoryIndexName,
  memoryKeyPrefix,
  MEMORY_INDEX_ALGORITHM,
} from '../buildMemoryIndex';

describe('buildMemoryIndex', () => {
  it('names the index and key prefix off the store name', () => {
    expect(memoryIndexName('mem')).toBe('mem:mem:idx');
    expect(memoryKeyPrefix('mem')).toBe('mem:mem:');
  });

  it('builds an FT.CREATE arg list scoped to the memory keyspace', () => {
    const args = buildMemoryIndexArgs('mem', 16);

    expect(args.slice(0, 7)).toEqual(['mem:mem:idx', 'ON', 'HASH', 'PREFIX', '1', 'mem:mem:', 'SCHEMA']);
  });

  it('declares the vector field with the configured dimension and cosine metric', () => {
    const args = buildMemoryIndexArgs('mem', 16);
    const vec = args.indexOf('vector');

    expect(args.slice(vec, vec + 12)).toEqual([
      'vector',
      'VECTOR',
      MEMORY_INDEX_ALGORITHM,
      '6',
      'TYPE',
      'FLOAT32',
      'DIM',
      '16',
      'DISTANCE_METRIC',
      'COSINE',
      'threadId',
      'TAG',
    ]);
  });

  it('indexes the scope/tag fields as TAG and tags as comma-separated', () => {
    const args = buildMemoryIndexArgs('mem', 16);
    const joined = args.join(' ');

    expect(joined).toContain('threadId TAG');
    expect(joined).toContain('agentId TAG');
    expect(joined).toContain('namespace TAG');
    expect(joined).toContain('tags TAG SEPARATOR ,');
    expect(joined).toContain('source TAG');
  });

  it('indexes the numeric tunables and the content text field', () => {
    const args = buildMemoryIndexArgs('mem', 16);
    const joined = args.join(' ');

    expect(joined).toContain('importance NUMERIC');
    expect(joined).toContain('created_at NUMERIC SORTABLE');
    for (const field of ['last_accessed_at', 'access_count']) {
      expect(joined).toContain(`${field} NUMERIC`);
    }
    expect(joined).toContain('content TEXT');
  });

  it('rejects a non-positive or non-integer dimension', () => {
    expect(() => buildMemoryIndexArgs('mem', 0)).toThrow(/positive integer/i);
    expect(() => buildMemoryIndexArgs('mem', -4)).toThrow(/positive integer/i);
    expect(() => buildMemoryIndexArgs('mem', 1.5)).toThrow(/positive integer/i);
  });
});
