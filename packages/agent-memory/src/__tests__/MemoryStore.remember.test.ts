import { describe, it, expect, vi } from 'vitest';
import { encodeFloat32 } from '@betterdb/valkey-search-kit';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

function hsetFields(call: unknown[]): Record<string, string | Buffer> {
  const fields = call.slice(2);
  const out: Record<string, string | Buffer> = {};
  for (let i = 0; i < fields.length; i += 2) {
    out[String(fields[i])] = fields[i + 1] as string | Buffer;
  }
  return out;
}

describe('MemoryStore.remember', () => {
  it('embeds content once, HSETs the memory hash, and returns an id', async () => {
    const embedFn = vi.fn(fakeEmbed(8));
    const client = mockClient();
    const store = new MemoryStore({ client, name: 'mem', embedFn });

    const id = await store.remember('the user prefers dark mode', {
      threadId: 't1',
      agentId: 'a1',
      namespace: 'user:1',
      tags: ['pref', 'ui'],
      source: 'user',
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith('the user prefers dark mode');

    const hset = client.call.mock.calls.find((args) => args[0] === 'HSET');
    expect(hset?.[1]).toBe(`mem:mem:${id}`);

    const fields = hsetFields(hset as unknown[]);
    expect(fields.content).toBe('the user prefers dark mode');
    expect(fields.threadId).toBe('t1');
    expect(fields.agentId).toBe('a1');
    expect(fields.namespace).toBe('user:1');
    expect(fields.tags).toBe('pref,ui');
    expect(fields.source).toBe('user');
    expect(fields.importance).toBe('0.5');
    expect(fields.access_count).toBe('0');
    expect(fields.vector).toEqual(encodeFloat32(await fakeEmbed(8)('the user prefers dark mode')));
    expect(typeof fields.created_at).toBe('string');
    expect(fields.last_accessed_at).toBe(fields.created_at);
  });

  it('honors a provided importance and omits absent optional fields', async () => {
    const client = mockClient();
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.remember('a bare fact', { importance: 0.9 });

    const hset = client.call.mock.calls.find((args) => args[0] === 'HSET');
    const fields = hsetFields(hset as unknown[]);
    expect(fields.importance).toBe('0.9');
    expect('tags' in fields).toBe(false);
    expect('threadId' in fields).toBe(false);
    expect('source' in fields).toBe(false);
  });

  it('throws when a later embedding has a mismatched dimension', async () => {
    let dims = 8;
    const embedFn = vi.fn(async () => new Array(dims).fill(0.1));
    const store = new MemoryStore({ client: mockClient(), name: 'mem', embedFn });

    await store.remember('first');
    dims = 4;

    await expect(store.remember('second')).rejects.toThrow(/dimension/i);
  });
});
