import { describe, it, expect, vi } from 'vitest';
import {
  REGISTRY_KEY,
  PROTOCOL_KEY,
  HEARTBEAT_KEY_PREFIX,
  PROTOCOL_VERSION,
} from '@betterdb/agent-cache';
import { MemoryDiscovery } from '../discovery';
import { mockClient } from './helpers/mockClient';

const HEARTBEAT_KEY = `${HEARTBEAT_KEY_PREFIX}mem:mem`;

function freshClient() {
  return mockClient((command) => (command === 'HGET' ? null : 'OK'));
}

function makeDiscovery(client: ReturnType<typeof mockClient>, overrides = {}) {
  return new MemoryDiscovery({
    client,
    name: 'mem',
    version: '1.2.3',
    statsKey: 'mem:__mem_stats',
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

describe('MemoryDiscovery', () => {
  it('registers an agent_memory marker with the memory capabilities and stats key', async () => {
    const client = freshClient();
    const disco = makeDiscovery(client);

    await disco.register();
    await disco.stop({ deleteHeartbeat: false });

    const hset = client.call.mock.calls.find((c) => c[0] === 'HSET' && c[1] === REGISTRY_KEY);
    expect(hset?.[2]).toBe('mem:mem');
    const marker = JSON.parse(hset?.[3] as string);
    expect(marker.type).toBe('agent_memory');
    expect(marker.prefix).toBe('mem');
    expect(marker.version).toBe('1.2.3');
    expect(marker.protocol_version).toBe(PROTOCOL_VERSION);
    expect(marker.capabilities).toEqual(['recall', 'consolidate', 'reinforce']);
    expect(marker.stats_key).toBe('mem:__mem_stats');
  });

  it('sets the protocol key with NX and writes a heartbeat with a TTL', async () => {
    const client = freshClient();
    const disco = makeDiscovery(client);

    await disco.register();
    await disco.stop({ deleteHeartbeat: false });

    const sets = client.call.mock.calls.filter((c) => c[0] === 'SET');
    expect(sets.some((c) => c[1] === PROTOCOL_KEY && c[3] === 'NX')).toBe(true);
    const heartbeat = sets.find((c) => c[1] === HEARTBEAT_KEY);
    expect(heartbeat?.[3]).toBe('EX');
    expect(heartbeat?.[4]).toBe('60');
  });

  it('warns (visibly) and overwrites on a collision with a different cache type', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = mockClient((command) =>
      command === 'HGET' ? JSON.stringify({ type: 'agent_cache' }) : 'OK',
    );
    const disco = makeDiscovery(client);

    // Registration must not reject into the swallowed promise; the collision is
    // surfaced via a visible warning and registration proceeds last-writer-wins.
    await expect(disco.register()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/marker/i);
    expect(client.call.mock.calls.some((c) => c[0] === 'HSET' && c[1] === REGISTRY_KEY)).toBe(true);
    warn.mockRestore();
  });

  it('overwrites an existing marker of the same type without throwing', async () => {
    const client = mockClient((command) =>
      command === 'HGET' ? JSON.stringify({ type: 'agent_memory', version: '0.0.1' }) : 'OK',
    );
    const disco = makeDiscovery(client);

    await disco.register();
    await disco.stop({ deleteHeartbeat: false });

    expect(client.call.mock.calls.some((c) => c[0] === 'HSET' && c[1] === REGISTRY_KEY)).toBe(true);
  });

  it('deletes the heartbeat key on stop when asked', async () => {
    const client = freshClient();
    const disco = makeDiscovery(client);

    await disco.register();
    await disco.stop({ deleteHeartbeat: true });

    expect(client.call.mock.calls.some((c) => c[0] === 'DEL' && c[1] === HEARTBEAT_KEY)).toBe(true);
  });

  it('re-writes the heartbeat and marker on tickHeartbeat', async () => {
    const client = freshClient();
    const disco = makeDiscovery(client);
    await disco.register();
    const before = client.call.mock.calls.length;

    await disco.tickHeartbeat();
    await disco.stop({ deleteHeartbeat: false });

    const after = client.call.mock.calls.slice(before);
    expect(after.some((c) => c[0] === 'SET' && c[1] === HEARTBEAT_KEY)).toBe(true);
    expect(after.some((c) => c[0] === 'HSET' && c[1] === REGISTRY_KEY)).toBe(true);
  });

  it('heartbeats on the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const client = freshClient();
      const disco = makeDiscovery(client, { heartbeatIntervalMs: 1000 });
      await disco.register();
      const before = client.call.mock.calls.filter((c) => c[0] === 'HSET').length;

      await vi.advanceTimersByTimeAsync(1000);

      const after = client.call.mock.calls.filter((c) => c[0] === 'HSET').length;
      expect(after).toBeGreaterThan(before);
      await disco.stop({ deleteHeartbeat: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for an in-flight heartbeat tick before deleting, so no write lands after stop', async () => {
    vi.useFakeTimers();
    try {
      let releaseTick: (value: unknown) => void = () => {};
      let gateArmed = false;
      const order: string[] = [];
      const client = mockClient((command, ...args) => {
        order.push(command);
        if (gateArmed && command === 'SET' && args[0] === HEARTBEAT_KEY) {
          return new Promise((resolve) => {
            releaseTick = resolve;
          });
        }
        return command === 'HGET' ? null : 'OK';
      });
      const disco = makeDiscovery(client, { heartbeatIntervalMs: 1000 });
      await disco.register();

      gateArmed = true;
      await vi.advanceTimersByTimeAsync(1000); // fire one tick; its heartbeat SET blocks

      const stopP = disco.stop({ deleteHeartbeat: true });
      expect(order.includes('DEL')).toBe(false); // DEL waits behind the in-flight tick

      releaseTick('OK');
      await stopP;
      expect(order[order.length - 1]).toBe('DEL'); // DEL is the final write
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when a registry write fails (best-effort)', async () => {
    const onWriteFailed = vi.fn();
    const client = mockClient((command) => {
      if (command === 'HGET') {
        return null;
      }
      if (command === 'HSET') {
        throw new Error('registry boom');
      }
      return 'OK';
    });
    const disco = makeDiscovery(client, { onWriteFailed });

    await expect(disco.register()).resolves.toBeUndefined();
    await disco.stop({ deleteHeartbeat: false });
    expect(onWriteFailed).toHaveBeenCalled();
  });
});
