import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { mockClient } from './helpers/mockClient';

describe('MemoryStore without embedFn', () => {
  it('constructs without an embedFn', () => {
    expect(() => new MemoryStore({ client: mockClient(), name: 'mem' })).not.toThrow();
  });

  it('rejects remember() with a clear error when embedFn is absent', async () => {
    const store = new MemoryStore({ client: mockClient(), name: 'mem' });
    await expect(store.remember('hi')).rejects.toThrow(/embedFn/);
  });

  it('rejects recall() with a clear error when embedFn is absent', async () => {
    const store = new MemoryStore({ client: mockClient(), name: 'mem' });
    await expect(store.recall('hi')).rejects.toThrow(/embedFn/);
  });
});
