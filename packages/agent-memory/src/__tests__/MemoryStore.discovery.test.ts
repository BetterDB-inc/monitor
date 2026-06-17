import { describe, it, expect } from 'vitest';
import { REGISTRY_KEY, HEARTBEAT_KEY_PREFIX } from '@betterdb/agent-cache';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

const HEARTBEAT_KEY = `${HEARTBEAT_KEY_PREFIX}mem:mem`;

describe('MemoryStore discovery wiring', () => {
  it('registers a discovery marker on construct when discovery is enabled', async () => {
    const client = mockClient((command) => (command === 'HGET' ? null : 'OK'));
    const store = new MemoryStore({
      client,
      name: 'mem',
      embedFn: fakeEmbed(8),
      discovery: { version: '1.0.0', heartbeatIntervalMs: 999_999 },
    });

    await store.close();

    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET' && c[1] === REGISTRY_KEY);
    expect(hset?.[2]).toBe('mem:mem');
    const marker = JSON.parse(hset?.[3] as string);
    expect(marker.type).toBe('agent_memory');
    expect(marker.stats_key).toBe('mem:__mem_stats');
    const del = client.call.mock.calls.find((c) => c[0] === 'DEL' && c[1] === HEARTBEAT_KEY);
    expect(del).toBeDefined();
  });

  it('does not touch the registry when discovery is not enabled', async () => {
    const client = mockClient(() => 'OK');
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.close();

    expect(client.call.mock.calls.some((c) => c[0] === 'HSET' && c[1] === REGISTRY_KEY)).toBe(
      false,
    );
  });
});
