import { describe, it, expect, vi } from 'vitest';
import { Registry } from 'prom-client';
import { AgentMemory, type AgentMemoryOptions } from '../AgentMemory';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';

function fakeValkey() {
  const ok = vi.fn(async () => 'OK');
  const nul = vi.fn(async () => null);
  return {
    call: vi.fn(async () => 'OK'),
    get: nul,
    set: ok,
    del: ok,
    hget: nul,
    hset: ok,
    hgetall: vi.fn(async () => ({})),
    hincrby: ok,
    expire: ok,
    exists: vi.fn(async () => 0),
    scan: vi.fn(async () => ['0', []]),
  };
}

type FakeClient = ReturnType<typeof fakeValkey>;

function makeOptions(overrides: Partial<AgentMemoryOptions> = {}): AgentMemoryOptions {
  return {
    client: fakeValkey() as unknown as AgentMemoryOptions['client'],
    embedFn: fakeEmbed(8),
    discovery: { enabled: false },
    configRefresh: { enabled: false },
    analytics: { disabled: true },
    ...overrides,
  } as AgentMemoryOptions;
}

describe('AgentMemory facade', () => {
  it('exposes the three short-term tiers plus the memory tier', async () => {
    const mem = new AgentMemory(makeOptions());

    expect(mem.llm).toBeDefined();
    expect(mem.tool).toBeDefined();
    expect(mem.session).toBeDefined();
    expect(mem.memory).toBeInstanceOf(MemoryStore);

    await mem.close();
  });

  it('throws a clear error when constructed without an embedFn', () => {
    const options = { ...makeOptions(), embedFn: undefined } as unknown as AgentMemoryOptions;
    expect(() => new AgentMemory(options)).toThrow(/embedFn/i);
  });

  it('wires the memory tier to the shared client and default prefix', async () => {
    const client = fakeValkey();
    const mem = new AgentMemory(
      makeOptions({ client: client as unknown as AgentMemoryOptions['client'] }),
    );

    const id = await mem.memory.remember('hello');

    expect(typeof id).toBe('string');
    const hset = (client.call.mock.calls as unknown[][]).find(
      (c) => c[0] === 'HSET' && typeof c[1] === 'string' && c[1].startsWith('betterdb_ac:mem:'),
    );
    expect(hset).toBeDefined();

    await mem.close();
  });

  it('shares the configured name as the memory key prefix', async () => {
    const client = fakeValkey();
    const mem = new AgentMemory(
      makeOptions({ client: client as unknown as AgentMemoryOptions['client'], name: 'myapp' }),
    );

    await mem.memory.remember('hello');

    const hset = (client.call.mock.calls as unknown[][]).find(
      (c) => c[0] === 'HSET' && typeof c[1] === 'string' && c[1].startsWith('myapp:mem:'),
    );
    expect(hset).toBeDefined();

    await mem.close();
  });

  it('maps the memory sub-config onto the MemoryStore', async () => {
    const mem = new AgentMemory(
      makeOptions({
        memory: {
          defaultThreshold: 0.4,
          recall: {
            weights: { similarity: 0.5, recency: 0.3, importance: 0.2 },
            halfLifeSeconds: 3600,
          },
          maxItemsPerScope: 100,
        },
      }),
    );

    expect(mem.memory.currentConfig()).toEqual({
      threshold: 0.4,
      weights: { similarity: 0.5, recency: 0.3, importance: 0.2 },
      halfLifeSeconds: 3600,
      maxItemsPerScope: 100,
    });

    await mem.close();
  });

  it('initialize() resolves and close() tears down both tiers', async () => {
    const mem = new AgentMemory(makeOptions());
    const memoryClose = vi.spyOn(mem.memory, 'close');

    await expect(mem.initialize()).resolves.toBeUndefined();
    await mem.close();

    expect(memoryClose).toHaveBeenCalled();
  });

  it('registers a memory discovery marker by default', async () => {
    const client = fakeValkey();
    const mem = new AgentMemory(
      makeOptions({ client: client as unknown as AgentMemoryOptions['client'] }),
    );

    await mem.initialize();

    const marker = (client.call.mock.calls as unknown[][]).find(
      (c) => c[0] === 'HSET' && c[1] === '__betterdb:caches',
    );
    expect(marker).toBeDefined();
    expect(JSON.parse(marker?.[3] as string).type).toBe('agent_memory');

    await mem.close();
  });

  it('allows disabling memory discovery', async () => {
    const client = fakeValkey();
    const mem = new AgentMemory(
      makeOptions({
        client: client as unknown as AgentMemoryOptions['client'],
        memory: { discovery: false },
      }),
    );

    await mem.initialize();
    await mem.close();

    const marker = (client.call.mock.calls as unknown[][]).find(
      (c) => c[0] === 'HSET' && c[1] === '__betterdb:caches',
    );
    expect(marker).toBeUndefined();
  });

  it('shares one prom registry across the cache and memory tiers', async () => {
    const registry = new Registry();
    const mem = new AgentMemory(makeOptions({ telemetry: { registry } }));

    await mem.memory.remember('x');

    const text = await registry.metrics();
    expect(text).toMatch(/agent_memory_embedding_calls_total/);
    expect(text).toMatch(/agent_cache_/);

    await mem.close();
  });
});

// Touch the FakeClient type so it is exercised by the suite.
export type { FakeClient };
