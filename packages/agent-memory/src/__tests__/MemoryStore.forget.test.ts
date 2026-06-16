import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

function searchReply(keys: string[]): unknown[] {
  const out: unknown[] = [String(keys.length)];
  for (const key of keys) {
    out.push(key, []);
  }
  return out;
}

describe('MemoryStore.forget', () => {
  it('DELs the memory hash and reports that it existed', async () => {
    const client = mockClient((command) => (command === 'DEL' ? 1 : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const ok = await store.forget('doc1');

    expect(ok).toBe(true);
    expect(client.call).toHaveBeenCalledWith('DEL', 'mem:mem:doc1');
  });

  it('returns false when the memory is absent (idempotent)', async () => {
    const client = mockClient((command) => (command === 'DEL' ? 0 : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    expect(await store.forget('missing')).toBe(false);
  });
});

describe('MemoryStore.forgetByScope', () => {
  it('FT.SEARCHes by scope, DELs the matches, and returns the count', async () => {
    const pages = [searchReply(['mem:mem:a', 'mem:mem:b']), searchReply([])];
    let call = 0;
    const client = mockClient((command, ...args) => {
      if (command === 'FT.SEARCH') {
        return pages[Math.min(call++, pages.length - 1)];
      }
      if (command === 'DEL') {
        return args.length;
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const count = await store.forgetByScope({ threadId: 't1', tags: ['x'] });

    expect(count).toBe(2);
    const search = client.call.mock.calls.find((c) => c[0] === 'FT.SEARCH');
    expect(search?.[1]).toBe('mem:mem:idx');
    expect(search?.[2]).toBe('(@threadId:{t1} @tags:{x})');
    expect(client.call).toHaveBeenCalledWith('DEL', 'mem:mem:a', 'mem:mem:b');
  });

  it('escapes glob chars so a threadId of "*" cannot over-match', async () => {
    const client = mockClient((command) => (command === 'FT.SEARCH' ? searchReply([]) : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.forgetByScope({ threadId: '*' });

    const search = client.call.mock.calls.find((args) => args[0] === 'FT.SEARCH');
    expect(search?.[2]).toBe('(@threadId:{\\*})');
  });

  it('throws when no scope field or tag is given (prevents mass delete)', async () => {
    const store = new MemoryStore({ client: mockClient(), name: 'mem', embedFn: fakeEmbed(8) });

    await expect(store.forgetByScope({})).rejects.toThrow(/scope/i);
  });

  it('returns 0 and issues no DEL when nothing matches', async () => {
    const client = mockClient((command) => (command === 'FT.SEARCH' ? searchReply([]) : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    expect(await store.forgetByScope({ threadId: 't' })).toBe(0);
    expect(client.call.mock.calls.some((args) => args[0] === 'DEL')).toBe(false);
  });

  it('paginates across batches so large scopes are not silently truncated', async () => {
    const batches = [
      searchReply(['mem:mem:a', 'mem:mem:b']),
      searchReply(['mem:mem:c']),
      searchReply([]),
    ];
    let call = 0;
    const client = mockClient((command, ...args) => {
      if (command === 'FT.SEARCH') {
        return batches[Math.min(call++, batches.length - 1)];
      }
      return command === 'DEL' ? args.length : 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    const count = await store.forgetByScope({ threadId: 't' });

    expect(count).toBe(3);
    const dels = client.call.mock.calls.filter((args) => args[0] === 'DEL');
    expect(dels).toHaveLength(2);
    expect(dels[0]).toEqual(['DEL', 'mem:mem:a', 'mem:mem:b']);
    expect(dels[1]).toEqual(['DEL', 'mem:mem:c']);
  });
});
