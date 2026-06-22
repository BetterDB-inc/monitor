import { describe, it, expect } from 'vitest';
import { encodeFloat32 } from '@betterdb/valkey-search-kit';
import { buildMemoryRecord } from '../buildMemoryRecord';

function toObject(fields: (string | Buffer)[]): Record<string, string | Buffer> {
  const out: Record<string, string | Buffer> = {};
  for (let i = 0; i < fields.length; i += 2) {
    out[String(fields[i])] = fields[i + 1];
  }
  return out;
}

describe('buildMemoryRecord', () => {
  it('builds the {name}:mem:{id} key and a deterministic field list', () => {
    const vector = [0.1, 0.2, 0.3, 0.4];
    const record = buildMemoryRecord(
      'mem',
      'id1',
      'hello world',
      vector,
      {
        threadId: 't',
        agentId: 'a',
        namespace: 'n',
        tags: ['x', 'y'],
        importance: 0.7,
        source: 'user',
      },
      1000,
    );

    expect(record.key).toBe('mem:mem:id1');
    const f = toObject(record.fields);
    expect(f.content).toBe('hello world');
    expect(f.importance).toBe('0.7');
    expect(f.tags).toBe('x,y');
    expect(f.threadId).toBe('t');
    expect(f.agentId).toBe('a');
    expect(f.namespace).toBe('n');
    expect(f.source).toBe('user');
    expect(f.created_at).toBe('1000');
    expect(f.last_accessed_at).toBe('1000');
    expect(f.access_count).toBe('0');
    expect(f.vector).toEqual(encodeFloat32(vector));
  });

  it('defaults importance to 0.5 and omits absent optional fields including empty tags', () => {
    const record = buildMemoryRecord('mem', 'id2', 'x', [0, 0], {}, 5);

    const f = toObject(record.fields);
    expect(f.importance).toBe('0.5');
    expect('tags' in f).toBe(false);
    expect('threadId' in f).toBe(false);
    expect('source' in f).toBe(false);
  });

  it('throws when a tag contains a comma (would break TAG tokenization)', () => {
    expect(() =>
      buildMemoryRecord('mem', 'id3', 'x', [0, 0], { tags: ['tool:web,search'] }, 5),
    ).toThrow(/comma/i);
  });

  it('rejects an importance outside [0, 1] or non-finite, so a bad value cannot poison ranking', () => {
    for (const bad of [NaN, Infinity, -Infinity, -0.1, 1.5, 42]) {
      expect(() =>
        buildMemoryRecord('mem', 'idx', 'x', [0, 0], { importance: bad }, 5),
      ).toThrow(/importance/i);
    }
  });

  it('accepts the inclusive [0, 1] bounds', () => {
    for (const ok of [0, 0.5, 1]) {
      const record = buildMemoryRecord('mem', 'idx', 'x', [0, 0], { importance: ok }, 5);
      expect(toObject(record.fields).importance).toBe(String(ok));
    }
  });
});
