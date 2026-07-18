import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../MemoryStore';
import { mockClient } from './helpers/mockClient';

describe('MemoryStore.stats', () => {
  it('returns item count, evictions, and the current config', async () => {
    const client = mockClient((command) => {
      if (command === 'FT.INFO') {
        return ['num_docs', '5', 'indexing', '0'];
      }
      if (command === 'HGETALL') {
        return ['evictions', '3'];
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem' });

    const stats = await store.stats();

    expect(stats.itemCount).toBe(5);
    expect(stats.evictions).toBe(3);
    expect(stats.config.threshold).toBeCloseTo(0.33);
    expect(client.call).toHaveBeenCalledWith('FT.INFO', 'mem:mem:idx');
    expect(client.call).toHaveBeenCalledWith('HGETALL', 'mem:__mem_stats');
  });

  it('reports 0 evictions when the stats hash is absent', async () => {
    const client = mockClient((command) => (command === 'FT.INFO' ? ['num_docs', '0', 'indexing', '0'] : []));
    const store = new MemoryStore({ client, name: 'mem' });

    expect((await store.stats()).evictions).toBe(0);
  });
});
