import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  DiscoveryManager,
  HEARTBEAT_KEY_PREFIX,
  HEARTBEAT_TTL_SECONDS,
  PROTOCOL_KEY,
  PROTOCOL_VERSION,
  REGISTRY_KEY,
  TOOL_POLICIES_LIMIT,
  buildAgentMetadata,
  type MarkerMetadata,
} from '../discovery';
import { AgentCacheUsageError } from '../errors';
import type { Valkey } from '../types';

interface SetCall {
  key: string;
  value: string;
  args: unknown[];
}

class FakeClient {
  hashes = new Map<string, Map<string, string>>();
  strings = new Map<string, { value: string; expiresAt: number | null }>();
  hgetCalls = 0;
  hsetCalls = 0;
  setCalls: SetCall[] = [];
  delCalls: string[] = [];

  private failNextHset = false;
  private failNextHget = false;

  failHsetOnce() {
    this.failNextHset = true;
  }

  failHgetOnce() {
    this.failNextHget = true;
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.hgetCalls++;
    if (this.failNextHget) {
      this.failNextHget = false;
      throw new Error('NOAUTH ACL denied');
    }
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.hsetCalls++;
    if (this.failNextHset) {
      this.failNextHset = false;
      throw new Error('NOAUTH ACL denied');
    }
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    const existed = hash.has(field);
    hash.set(field, value);
    return existed ? 0 : 1;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
    this.setCalls.push({ key, value, args });
    const hasNX = args.includes('NX');
    if (hasNX && this.strings.has(key)) {
      return null;
    }
    const exIndex = args.indexOf('EX');
    const expiresAt =
      exIndex >= 0 && typeof args[exIndex + 1] === 'number'
        ? Date.now() + (args[exIndex + 1] as number) * 1000
        : null;
    this.strings.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      this.delCalls.push(key);
      if (this.strings.delete(key)) n++;
    }
    return n;
  }
}

function asValkey(client: FakeClient): Valkey {
  return client as unknown as Valkey;
}

function agentMetadata(
  name: string,
  overrides: Partial<BuildAgentMetadataInput> = {},
): MarkerMetadata {
  return buildAgentMetadata({
    name,
    version: '0.5.0',
    tiers: {},
    defaultTtl: undefined,
    toolPolicyNames: [],
    hasCostTable: false,
    usesDefaultCostTable: true,
    startedAt: new Date().toISOString(),
    includeToolPolicies: true,
    ...overrides,
  });
}

type BuildAgentMetadataInput = Parameters<typeof buildAgentMetadata>[0];

describe('buildAgentMetadata', () => {
  it('publishes tool_ttl_adjust, invalidate_by_tool, tool_effectiveness capabilities', () => {
    const meta = agentMetadata('foo');
    expect(meta.capabilities).toContain('tool_ttl_adjust');
    expect(meta.capabilities).toContain('invalidate_by_tool');
    expect(meta.capabilities).toContain('tool_effectiveness');
  });

  it('derives stats_key from the cache name', () => {
    const meta = agentMetadata('prod-agent');
    expect(meta.stats_key).toBe('prod-agent:__stats');
  });

  it('includes tool_policies when includeToolPolicies is true', () => {
    const meta = agentMetadata('foo', {
      toolPolicyNames: ['weather', 'classify'],
    });
    expect(meta.tool_policies).toEqual(['weather', 'classify']);
    expect(meta.tool_policies_truncated).toBeUndefined();
  });

  it('omits tool_policies when includeToolPolicies is false', () => {
    const meta = agentMetadata('foo', {
      includeToolPolicies: false,
      toolPolicyNames: ['weather'],
    });
    expect(meta.tool_policies).toBeUndefined();
  });

  it(`caps tool_policies at ${TOOL_POLICIES_LIMIT} and sets tool_policies_truncated`, () => {
    const many = Array.from({ length: TOOL_POLICIES_LIMIT + 50 }, (_, i) => `tool_${i}`);
    const meta = agentMetadata('foo', { toolPolicyNames: many });
    expect(Array.isArray(meta.tool_policies)).toBe(true);
    expect((meta.tool_policies as string[]).length).toBe(TOOL_POLICIES_LIMIT);
    expect(meta.tool_policies_truncated).toBe(true);
  });

  it('tier ttl_default falls back to defaultTtl when the per-tier value is missing', () => {
    const meta = agentMetadata('foo', {
      tiers: { tool: { ttl: 60 } },
      defaultTtl: 3600,
    });
    const tiers = meta.tiers as Record<string, { ttl_default?: number }>;
    expect(tiers.tool.ttl_default).toBe(60);
    expect(tiers.llm.ttl_default).toBe(3600);
    expect(tiers.session.ttl_default).toBe(3600);
  });
});

describe('DiscoveryManager.register', () => {
  let client: FakeClient;
  let onWriteFailed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new FakeClient();
    onWriteFailed = vi.fn();
  });

  it('writes the registry hash and protocol key on a fresh Valkey', async () => {
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      cacheType: 'agent_cache',
      buildMetadata: () => agentMetadata('foo'),
      heartbeatIntervalMs: 999_999,
      onWriteFailed,
    });

    await mgr.register();

    const entry = client.hashes.get(REGISTRY_KEY)?.get('foo');
    expect(entry).toBeDefined();
    const parsed = JSON.parse(entry ?? '{}') as MarkerMetadata;
    expect(parsed.type).toBe('agent_cache');
    expect(parsed.prefix).toBe('foo');
    expect(parsed.protocol_version).toBe(PROTOCOL_VERSION);

    const protocolSet = client.setCalls.find((c) => c.key === PROTOCOL_KEY);
    expect(protocolSet?.args).toContain('NX');

    await mgr.stop({ deleteHeartbeat: true });
  });

  it('throws AgentCacheUsageError on cross-type collision with a semantic_cache', async () => {
    const ownerJson = JSON.stringify({ ...agentMetadata('foo'), type: 'semantic_cache' });
    client.hashes.set(REGISTRY_KEY, new Map([['foo', ownerJson]]));

    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      cacheType: 'agent_cache',
      buildMetadata: () => agentMetadata('foo'),
      heartbeatIntervalMs: 999_999,
    });

    await expect(mgr.register()).rejects.toBeInstanceOf(AgentCacheUsageError);
    await expect(mgr.register()).rejects.toThrow(/semantic_cache/);

    // No registry overwrite happened
    expect(client.hashes.get(REGISTRY_KEY)?.get('foo')).toBe(ownerJson);
  });

  it('overwrites (with a warning) when a same-type marker has a different version', async () => {
    const ownerJson = JSON.stringify(agentMetadata('foo'));
    // Rewrite with a lower version
    const older = JSON.parse(ownerJson) as MarkerMetadata;
    older.version = '0.4.5';
    client.hashes.set(REGISTRY_KEY, new Map([['foo', JSON.stringify(older)]]));

    const warn = vi.fn();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      cacheType: 'agent_cache',
      buildMetadata: () => agentMetadata('foo'),
      heartbeatIntervalMs: 999_999,
      logger: { warn, debug: () => {} },
    });

    await mgr.register();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/overwriting marker/));
    const parsed = JSON.parse(client.hashes.get(REGISTRY_KEY)?.get('foo') ?? '{}') as MarkerMetadata;
    expect(parsed.version).toBe('0.5.0');

    await mgr.stop({ deleteHeartbeat: true });
  });

  it('does not throw when HSET fails (ACL denied); counter increments', async () => {
    client.failHsetOnce();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      cacheType: 'agent_cache',
      buildMetadata: () => agentMetadata('foo'),
      heartbeatIntervalMs: 999_999,
      onWriteFailed,
    });

    await expect(mgr.register()).resolves.toBeUndefined();
    expect(onWriteFailed).toHaveBeenCalled();

    await mgr.stop({ deleteHeartbeat: true });
  });
});

describe('DiscoveryManager heartbeat', () => {
  it('tickHeartbeat writes the heartbeat key with the 60s TTL and refreshes metadata', async () => {
    const client = new FakeClient();
    let toolPolicyNames: string[] = [];
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      cacheType: 'agent_cache',
      buildMetadata: () => agentMetadata('foo', { toolPolicyNames }),
      heartbeatIntervalMs: 999_999,
    });

    await mgr.register();

    // Simulate setPolicy adding a tool after register() ran
    toolPolicyNames = ['weather_lookup'];
    await mgr.tickHeartbeat();

    const heartbeatSet = client.setCalls.find(
      (c) => c.key === `${HEARTBEAT_KEY_PREFIX}foo`,
    );
    expect(heartbeatSet).toBeDefined();
    const exIndex = heartbeatSet?.args.indexOf('EX') ?? -1;
    expect(heartbeatSet?.args[exIndex + 1]).toBe(HEARTBEAT_TTL_SECONDS);

    const refreshed = client.hashes.get(REGISTRY_KEY)?.get('foo');
    expect(refreshed).toBeDefined();
    const parsed = JSON.parse(refreshed ?? '{}') as MarkerMetadata;
    expect(parsed.tool_policies).toEqual(['weather_lookup']);
  });

  it('stop({ deleteHeartbeat: true }) deletes the heartbeat key without touching the registry', async () => {
    const client = new FakeClient();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      cacheType: 'agent_cache',
      buildMetadata: () => agentMetadata('foo'),
      heartbeatIntervalMs: 999_999,
    });
    await mgr.register();
    await mgr.tickHeartbeat();

    const registryBefore = client.hashes.get(REGISTRY_KEY)?.get('foo');

    await mgr.stop({ deleteHeartbeat: true });

    expect(client.delCalls).toContain(`${HEARTBEAT_KEY_PREFIX}foo`);
    expect(client.hashes.get(REGISTRY_KEY)?.get('foo')).toBe(registryBefore);
  });
});
