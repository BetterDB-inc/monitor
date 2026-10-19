import Valkey, { Cluster } from 'iovalkey';
import {
  checkKeyOverlap,
  checkTargetCapacity,
  keyspaceTotals,
  readTargetMemory,
  sampleKeyOverlap,
  sourceExpiringKeysFrom,
  type MasterMemory,
  type TargetMemory,
} from '../analysis/capacity-checker';

const GiB = 1024 ** 3;

function master(overrides: Partial<MasterMemory> = {}): MasterMemory {
  return {
    name: 'target',
    maxmemory: 10 * GiB,
    usedMemory: 2 * GiB,
    policy: 'noeviction',
    keys: 0,
    expires: 0,
    slotShare: 1,
    ...overrides,
  };
}

/** A cluster master with 4 GiB maxmemory, 1 GiB used and half the slots. */
function shard(name: string, overrides: Partial<MasterMemory> = {}): MasterMemory {
  return master({ name, maxmemory: 4 * GiB, usedMemory: GiB, slotShare: 0.5, ...overrides });
}

function target(...masters: MasterMemory[]): TargetMemory {
  const list = masters.length > 0 ? masters : [master()];
  return { masters: list, keys: list.reduce((s, m) => s + m.keys, 0) };
}

interface NodeSpec {
  maxmemory: number;
  used: number;
  policy: string;
  notCounted?: number;
  keys?: number;
  expires?: number;
  host?: string;
  port?: number;
}

function node(spec: NodeSpec) {
  return {
    options: { host: spec.host ?? '127.0.0.1', port: spec.port ?? 6379 },
    info: jest
      .fn()
      .mockImplementation((section: string) =>
        Promise.resolve(
          section === 'memory'
            ? `# Memory\r\nused_memory:${spec.used}\r\nmaxmemory:${spec.maxmemory}\r\nmaxmemory_policy:${spec.policy}\r\nmem_not_counted_for_evict:${spec.notCounted ?? 0}\r\n`
            : `# Keyspace\r\ndb0:keys=${spec.keys ?? 0},expires=${spec.expires ?? 0},avg_ttl=0\r\n`,
        ),
      ),
    exists: jest.fn(),
  };
}

function cluster(nodes: ReturnType<typeof node>[], slots?: string[][]): Cluster {
  const c = Object.create(Cluster.prototype) as Cluster;
  c.nodes = jest.fn().mockReturnValue(nodes) as unknown as Cluster['nodes'];
  if (slots) (c as unknown as { slots: string[][] }).slots = slots;
  return c;
}

describe('capacity-checker / checkTargetCapacity (standalone)', () => {
  it('blocks when the dataset does not fit and the target cannot evict', () => {
    const [issue] = checkTargetCapacity(9 * GiB, target());
    expect(issue).toMatchObject({
      severity: 'blocking',
      category: 'capacity',
      title: 'Target does not have enough memory',
    });
    expect(issue.detail).toContain('8 GB free of 10 GB maxmemory');
  });

  it('warns about eviction instead of blocking under an allkeys policy', () => {
    const [issue] = checkTargetCapacity(9 * GiB, target(master({ policy: 'allkeys-lru' })));
    expect(issue).toMatchObject({
      severity: 'warning',
      title: 'Target will evict data during migration',
    });
    expect(issue.detail).toContain('evict about 1 GB');
  });

  it('warns under a volatile policy when the target has TTL keys, and mentions OOM', () => {
    const [issue] = checkTargetCapacity(
      9 * GiB,
      target(master({ policy: 'volatile-lru', expires: 5 })),
      0,
    );
    expect(issue.severity).toBe('warning');
    expect(issue.detail).toContain('fail with OOM');
  });

  it('warns under a volatile policy when only the source has TTL keys', () => {
    const [issue] = checkTargetCapacity(9 * GiB, target(master({ policy: 'volatile-lru' })), 12);
    expect(issue.severity).toBe('warning');
  });

  it('warns, not blocks, under a volatile policy when the source TTL count is unknown', () => {
    expect(
      checkTargetCapacity(9 * GiB, target(master({ policy: 'volatile-lru' })), null)[0].severity,
    ).toBe('warning');
    expect(
      checkTargetCapacity(9 * GiB, target(master({ policy: 'volatile-ttl' })))[0].severity,
    ).toBe('warning');
  });

  it('blocks under a volatile policy when neither side has TTL keys to evict', () => {
    const [issue] = checkTargetCapacity(9 * GiB, target(master({ policy: 'volatile-lru' })), 0);
    expect(issue).toMatchObject({ severity: 'blocking', category: 'capacity' });
    expect(issue.detail).toContain('only evicts keys with a TTL');
  });

  it('warns when the fit leaves under 10% headroom', () => {
    expect(checkTargetCapacity(7.5 * GiB, target())).toEqual([
      expect.objectContaining({ severity: 'warning', title: 'Target memory is tight' }),
    ]);
  });

  it('is silent when the dataset fits comfortably', () => {
    expect(checkTargetCapacity(4 * GiB, target())).toEqual([]);
  });

  it('is silent when the target has no maxmemory or the source size is unknown', () => {
    expect(checkTargetCapacity(100 * GiB, target(master({ maxmemory: 0 })))).toEqual([]);
    expect(checkTargetCapacity(0, target())).toEqual([]);
  });
});

describe('capacity-checker / checkTargetCapacity (cluster)', () => {
  it('still checks a capped master when another master has no limit', () => {
    const issues = checkTargetCapacity(
      2 * GiB,
      target(shard('10.0.0.1:6379', { maxmemory: 0 }), shard('10.0.0.2:6379', { usedMemory: 4 * GiB })),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'blocking', category: 'capacity' });
    expect(issues[0].detail).toContain('10.0.0.2:6379');
  });

  it('warns instead of blocking when every master evicts under different allkeys policies', () => {
    const [issue] = checkTargetCapacity(
      8 * GiB,
      target(
        shard('10.0.0.1:6379', { policy: 'allkeys-lru' }),
        shard('10.0.0.2:6379', { policy: 'allkeys-lfu' }),
      ),
    );
    expect(issue).toMatchObject({
      severity: 'warning',
      title: 'Target will evict data during migration',
    });
  });

  it('blocks when any master cannot evict, and says how many masters are flagged', () => {
    const issues = checkTargetCapacity(
      8 * GiB,
      target(
        shard('10.0.0.1:6379', { policy: 'noeviction' }),
        shard('10.0.0.2:6379', { policy: 'allkeys-lru' }),
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocking');
    expect(issues[0].detail).toContain('10.0.0.1:6379');
    expect(issues[0].detail).toContain('2 of 2 target masters are flagged');
  });

  it('catches a shard that overflows even though the cluster total fits', () => {
    // 5 GiB source, 6 GiB free in total; the 80% shard needs 4 GiB but has 3 GiB.
    const [issue] = checkTargetCapacity(
      5 * GiB,
      target(
        shard('10.0.0.1:6379', { slotShare: 0.8 }),
        shard('10.0.0.2:6379', { slotShare: 0.2 }),
      ),
    );
    expect(issue.severity).toBe('blocking');
    expect(issue.detail).toContain('10.0.0.1:6379');
    expect(issue.detail).toContain('80% of the hash slots');
  });

  it('judges each volatile master by its own TTL keys', () => {
    const [issue] = checkTargetCapacity(
      8 * GiB,
      target(
        shard('10.0.0.1:6379', { policy: 'volatile-lru', expires: 0 }),
        shard('10.0.0.2:6379', { policy: 'volatile-lru', expires: 100 }),
      ),
      0,
    );
    expect(issue.severity).toBe('blocking');
    expect(issue.detail).toContain('10.0.0.1:6379');
  });

  it('is silent when every master is unlimited', () => {
    expect(
      checkTargetCapacity(
        100 * GiB,
        target(shard('10.0.0.1:6379', { maxmemory: 0 }), shard('10.0.0.2:6379', { maxmemory: 0 })),
      ),
    ).toEqual([]);
  });
});

describe('capacity-checker / checkKeyOverlap', () => {
  it('is silent for an empty target', () => {
    expect(checkKeyOverlap(0, null)).toEqual([]);
  });

  it('warns with the sampled collision rate', () => {
    const [issue] = checkKeyOverlap(5000, { sampled: 200, existing: 50 });
    expect(issue).toMatchObject({ severity: 'warning', category: 'key_overlap' });
    expect(issue.detail).toContain('50 of 200 sampled source keys (25%)');
  });

  it('only notes a non-empty target when no sampled key collides', () => {
    expect(checkKeyOverlap(5000, { sampled: 200, existing: 0 })[0].severity).toBe('info');
  });
});

describe('capacity-checker / readTargetMemory', () => {
  it('reads a standalone target and excludes memory not counted for eviction', async () => {
    const client = node({
      maxmemory: 10 * GiB,
      used: 3 * GiB,
      notCounted: GiB,
      policy: 'allkeys-lru',
      keys: 42,
      expires: 7,
    }) as unknown as Valkey;
    expect(await readTargetMemory(client)).toEqual({
      masters: [
        {
          name: 'target',
          maxmemory: 10 * GiB,
          usedMemory: 2 * GiB,
          policy: 'allkeys-lru',
          keys: 42,
          expires: 7,
          slotShare: 1,
        },
      ],
      keys: 42,
    });
  });

  it('never reports negative used memory', async () => {
    const client = node({
      maxmemory: GiB,
      used: 100,
      notCounted: 500,
      policy: 'noeviction',
    }) as unknown as Valkey;
    expect((await readTargetMemory(client)).masters[0].usedMemory).toBe(0);
  });

  it('keeps one entry per cluster master, weighted by the slots it owns', async () => {
    const c = cluster(
      [
        node({ maxmemory: 4 * GiB, used: GiB, policy: 'noeviction', keys: 10, host: '10.0.0.1', port: 6379 }),
        node({ maxmemory: 0, used: GiB, policy: 'allkeys-lru', keys: 20, host: '10.0.0.2', port: 6379 }),
      ],
      [
        ['10.0.0.1:6379', '10.0.0.3:6379'],
        ['10.0.0.1:6379', '10.0.0.3:6379'],
        ['10.0.0.1:6379', '10.0.0.3:6379'],
        ['10.0.0.2:6379', '10.0.0.4:6379'],
      ],
    );
    const memory = await readTargetMemory(c as unknown as Valkey);
    expect(c.nodes).toHaveBeenCalledWith('master');
    expect(memory.keys).toBe(30);
    expect(memory.masters).toEqual([
      expect.objectContaining({ name: '10.0.0.1:6379', slotShare: 0.75, policy: 'noeviction', maxmemory: 4 * GiB }),
      expect.objectContaining({ name: '10.0.0.2:6379', slotShare: 0.25, policy: 'allkeys-lru', maxmemory: 0 }),
    ]);
  });

  it('falls back to equal shares when the slot map is unavailable', async () => {
    const c = cluster([
      node({ maxmemory: GiB, used: 0, policy: 'noeviction', host: '10.0.0.1' }),
      node({ maxmemory: GiB, used: 0, policy: 'noeviction', host: '10.0.0.2' }),
    ]);
    const memory = await readTargetMemory(c as unknown as Valkey);
    expect(memory.masters.map((m) => m.slotShare)).toEqual([0.5, 0.5]);
  });

  it('throws when the cluster reports no masters', async () => {
    await expect(readTargetMemory(cluster([]) as unknown as Valkey)).rejects.toThrow(
      'No target masters available',
    );
  });
});

describe('capacity-checker / keyspaceTotals and sourceExpiringKeysFrom', () => {
  const info = '# Keyspace\r\ndb0:keys=5,expires=2,avg_ttl=0\r\ndb3:keys=10,expires=0,avg_ttl=0\r\n';
  const noTtl = '# Keyspace\r\ndb0:keys=5,expires=0,avg_ttl=0\r\n';

  it('sums keys and expires over every db', () => {
    expect(keyspaceTotals(info)).toEqual({ keys: 15, expires: 2 });
  });

  it('returns the TTL key count, or null when it cannot be trusted', () => {
    expect(sourceExpiringKeysFrom(info, false)).toBe(2);
    expect(sourceExpiringKeysFrom(noTtl, true)).toBe(0);
    expect(sourceExpiringKeysFrom(noTtl, false)).toBeNull();
    expect(sourceExpiringKeysFrom(undefined, true)).toBeNull();
  });
});

describe('capacity-checker / sampleKeyOverlap', () => {
  it('checks at most 200 keys, one EXISTS per key', async () => {
    const exists = jest
      .fn()
      .mockImplementation((key: string) => Promise.resolve(key.endsWith('0') ? 1 : 0));
    const keys = Array.from({ length: 500 }, (_, i) => `k:${i}`);
    const overlap = await sampleKeyOverlap({ exists } as unknown as Valkey, keys);
    expect(exists).toHaveBeenCalledTimes(200);
    expect(overlap).toEqual({ sampled: 200, existing: 20 });
  });
});
