import { describe, it, expect, vi } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';
import { buildMemoryIndexArgs } from '../buildMemoryIndex';

function indexNotFound(): Error {
  return new Error("Unknown index name 'mem:mem:idx'");
}

describe('MemoryStore.ensureIndex', () => {
  it('creates the index with the memory schema when it does not exist', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.INFO') {
        throw indexNotFound();
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(16) });

    await store.ensureIndex();

    const create = client.call.mock.calls.find((c) => c[0] === 'FT.CREATE');
    expect(create).toEqual(['FT.CREATE', ...buildMemoryIndexArgs('mem', 16)]);
  });

  it('is idempotent — does not re-create an existing index', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.INFO') {
        return ['index_name', 'mem:mem:idx'];
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(16) });

    await store.ensureIndex();

    expect(client.call.mock.calls.some((c) => c[0] === 'FT.CREATE')).toBe(false);
  });

  it('resolves the vector dimension from embedFn when none has been observed', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.INFO') {
        throw indexNotFound();
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(32) });

    await store.ensureIndex();

    const create = client.call.mock.calls.find((c) => c[0] === 'FT.CREATE');
    const dimIdx = create?.indexOf('DIM') ?? -1;
    expect(create?.[dimIdx + 1]).toBe('32');
  });

  it('reuses the dimension already observed from a write without re-probing', async () => {
    const embedFn = vi.fn(fakeEmbed(16));
    const client = mockClient((command) => {
      if (command === 'FT.INFO') {
        throw indexNotFound();
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn });
    await store.remember('seed');
    const callsAfterWrite = embedFn.mock.calls.length;

    await store.ensureIndex();

    expect(embedFn.mock.calls.length).toBe(callsAfterWrite);
    const create = client.call.mock.calls.find((c) => c[0] === 'FT.CREATE');
    const dimIdx = create?.indexOf('DIM') ?? -1;
    expect(create?.[dimIdx + 1]).toBe('16');
  });

  it('rethrows FT.INFO errors that are not "index not found"', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.INFO') {
        throw new Error('CONNECTION BROKEN');
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(16) });

    await expect(store.ensureIndex()).rejects.toThrow(/connection broken/i);
    expect(client.call.mock.calls.some((c) => c[0] === 'FT.CREATE')).toBe(false);
  });
});
