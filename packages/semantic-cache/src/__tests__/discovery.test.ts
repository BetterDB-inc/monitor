import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  DiscoveryManager,
  HEARTBEAT_KEY_PREFIX,
  HEARTBEAT_TTL_SECONDS,
  PROTOCOL_KEY,
  PROTOCOL_VERSION,
  REGISTRY_KEY,
  buildSemanticMetadata,
  type MarkerMetadata,
} from '../discovery';
import { SemanticCacheUsageError } from '../errors';
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

  private failNextHget = false;
  private failNextHset = false;
  private failSetsMatching: ((key: string, args: unknown[]) => boolean) | null = null;

  failHgetOnce() {
    this.failNextHget = true;
  }

  failHsetOnce() {
    this.failNextHset = true;
  }

  failSetsMatchingPredicate(pred: (key: string, args: unknown[]) => boolean) {
    this.failSetsMatching = pred;
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
    if (this.failSetsMatching?.(key, args)) {
      throw new Error('NOAUTH ACL denied');
    }
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
  // Cast through unknown — FakeClient implements only the subset of iovalkey
  // methods that DiscoveryManager uses.
  return client as unknown as Valkey;
}

function metadataFor(name: string, overrides: Partial<MarkerMetadata> = {}): MarkerMetadata {
  return {
    ...buildSemanticMetadata({
      name,
      version: '0.2.0',
      defaultThreshold: 0.1,
      categoryThresholds: {},
      uncertaintyBand: 0.05,
      includeCategories: true,
    }),
    ...overrides,
  };
}

describe('buildSemanticMetadata', () => {
  it('publishes capabilities without threshold_adjust until runtime config-hash reads ship', () => {
    const meta = buildSemanticMetadata({
      name: 'foo',
      version: '0.2.0',
      defaultThreshold: 0.1,
      categoryThresholds: {},
      uncertaintyBand: 0.05,
      includeCategories: true,
    });
    expect(meta.capabilities).toEqual(['invalidate', 'similarity_distribution']);
    expect(meta.capabilities).not.toContain('threshold_adjust');
  });

  it('derives index/stats/config keys from the cache name', () => {
    const meta = buildSemanticMetadata({
      name: 'faq-cache',
      version: '0.2.0',
      defaultThreshold: 0.1,
      categoryThresholds: {},
      uncertaintyBand: 0.05,
      includeCategories: true,
    });
    expect(meta.index_name).toBe('faq-cache:idx');
    expect(meta.stats_key).toBe('faq-cache:__stats');
    expect(meta.config_key).toBe('faq-cache:__config');
  });

  it('omits category_thresholds when includeCategories is false', () => {
    const meta = buildSemanticMetadata({
      name: 'foo',
      version: '0.2.0',
      defaultThreshold: 0.1,
      categoryThresholds: { faq: 0.08 },
      uncertaintyBand: 0.05,
      includeCategories: false,
    });
    expect(meta.category_thresholds).toBeUndefined();
  });

  it('omits category_thresholds when there are none even if includeCategories is true', () => {
    const meta = buildSemanticMetadata({
      name: 'foo',
      version: '0.2.0',
      defaultThreshold: 0.1,
      categoryThresholds: {},
      uncertaintyBand: 0.05,
      includeCategories: true,
    });
    expect(meta.category_thresholds).toBeUndefined();
  });
});

describe('DiscoveryManager.register', () => {
  let client: FakeClient;
  let onWriteFailed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new FakeClient();
    onWriteFailed = vi.fn();
  });

  afterEach(async () => {
    // Nothing to clean — heartbeats are .unref()'d.
  });

  it('writes the registry hash and protocol key on a fresh Valkey', async () => {
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
      onWriteFailed,
    });

    await mgr.register();

    const entry = client.hashes.get(REGISTRY_KEY)?.get('foo');
    expect(entry).toBeDefined();
    const parsed = JSON.parse(entry ?? '{}') as MarkerMetadata;
    expect(parsed.type).toBe('semantic_cache');
    expect(parsed.prefix).toBe('foo');
    expect(parsed.protocol_version).toBe(PROTOCOL_VERSION);

    const protocolSet = client.setCalls.find((c) => c.key === PROTOCOL_KEY);
    expect(protocolSet).toBeDefined();
    expect(protocolSet?.args).toContain('NX');

    await mgr.stop({ deleteHeartbeat: true });
  });

  it('throws SemanticCacheUsageError on cross-type collision', async () => {
    const ownerJson = JSON.stringify(metadataFor('foo', { type: 'agent_cache' }));
    client.hashes.set(REGISTRY_KEY, new Map([['foo', ownerJson]]));

    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
      onWriteFailed,
    });

    await expect(mgr.register()).rejects.toBeInstanceOf(SemanticCacheUsageError);
    await expect(mgr.register()).rejects.toThrow(/agent_cache/);

    // No registry overwrite happened
    expect(client.hashes.get(REGISTRY_KEY)?.get('foo')).toBe(ownerJson);
  });

  it('overwrites (with a warning) when a same-type marker has a different version', async () => {
    const ownerJson = JSON.stringify(metadataFor('foo', { version: '0.1.99' }));
    client.hashes.set(REGISTRY_KEY, new Map([['foo', ownerJson]]));

    const warn = vi.fn();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo', { version: '0.2.0' }),
      heartbeatIntervalMs: 999_999,
      logger: { warn, debug: () => {} },
      onWriteFailed,
    });

    await mgr.register();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/overwriting marker/));
    const parsed = JSON.parse(client.hashes.get(REGISTRY_KEY)?.get('foo') ?? '{}') as MarkerMetadata;
    expect(parsed.version).toBe('0.2.0');

    await mgr.stop({ deleteHeartbeat: true });
  });

  it('does not throw when HSET fails (ACL denied); counter increments', async () => {
    client.failHsetOnce();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
      onWriteFailed,
    });

    await expect(mgr.register()).resolves.toBeUndefined();
    expect(onWriteFailed).toHaveBeenCalled();

    await mgr.stop({ deleteHeartbeat: true });
  });

  it('does not throw when HGET fails; collision check is skipped', async () => {
    client.failHgetOnce();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
      onWriteFailed,
    });

    await expect(mgr.register()).resolves.toBeUndefined();
    expect(onWriteFailed).toHaveBeenCalled();
    // HSET still ran after the HGET failure
    expect(client.hsetCalls).toBe(1);

    await mgr.stop({ deleteHeartbeat: true });
  });

  it('writes the initial heartbeat synchronously during register()', async () => {
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
      onWriteFailed,
    });

    await mgr.register();

    // The heartbeat key must exist before any scheduled tick has had a
    // chance to fire — Monitor needs to see the cache as alive immediately.
    const heartbeatEntry = client.strings.get(`${HEARTBEAT_KEY_PREFIX}foo`);
    expect(heartbeatEntry).toBeDefined();
    expect(heartbeatEntry?.expiresAt).not.toBeNull();

    await mgr.stop({ deleteHeartbeat: true });
  });
});

describe('DiscoveryManager heartbeat', () => {
  it('tickHeartbeat writes the heartbeat key with the 60s TTL', async () => {
    const client = new FakeClient();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
    });

    await mgr.tickHeartbeat();

    const heartbeatSet = client.setCalls.find(
      (c) => c.key === `${HEARTBEAT_KEY_PREFIX}foo`,
    );
    expect(heartbeatSet).toBeDefined();
    const exIndex = heartbeatSet?.args.indexOf('EX') ?? -1;
    expect(exIndex).toBeGreaterThanOrEqual(0);
    expect(heartbeatSet?.args[exIndex + 1]).toBe(HEARTBEAT_TTL_SECONDS);
    // Value parses as an ISO 8601 date
    expect(new Date(heartbeatSet?.value ?? '').toString()).not.toBe('Invalid Date');
  });

  it('stop({ deleteHeartbeat: true }) deletes the heartbeat key', async () => {
    const client = new FakeClient();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
    });
    await mgr.register();
    await mgr.tickHeartbeat();

    await mgr.stop({ deleteHeartbeat: true });

    expect(client.delCalls).toContain(`${HEARTBEAT_KEY_PREFIX}foo`);
  });

  it('stop({ deleteHeartbeat: false }) leaves the heartbeat key to expire naturally', async () => {
    const client = new FakeClient();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
    });
    await mgr.register();

    await mgr.stop({ deleteHeartbeat: false });

    expect(client.delCalls).toHaveLength(0);
  });

  it('tickHeartbeat() SET failure bumps the onWriteFailed counter', async () => {
    const client = new FakeClient();
    client.failSetsMatchingPredicate((key) => key === `${HEARTBEAT_KEY_PREFIX}foo`);
    const onWriteFailed = vi.fn();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
      onWriteFailed,
    });

    await mgr.tickHeartbeat();

    expect(onWriteFailed).toHaveBeenCalled();
  });

  it('does not touch the registry hash on stop', async () => {
    const client = new FakeClient();
    const mgr = new DiscoveryManager({
      client: asValkey(client),
      name: 'foo',
      metadata: metadataFor('foo'),
      heartbeatIntervalMs: 999_999,
    });
    await mgr.register();
    const before = client.hashes.get(REGISTRY_KEY)?.get('foo');

    await mgr.stop({ deleteHeartbeat: true });

    expect(client.hashes.get(REGISTRY_KEY)?.get('foo')).toBe(before);
  });
});
