import Valkey, { Cluster } from 'iovalkey';
import {
  capacitySourceSize,
  checkKeyOverlap,
  checkTargetCapacity,
  keyspaceTotals,
  pickOverlapSample,
  probeTargetCapacity,
  readTargetMemory,
  sampleKeyOverlap,
  sourceDb0Share,
  sourceExpiringKeysFrom,
  type MasterMemory,
  type TargetMemory,
} from '../analysis/capacity-checker';
import { createTargetClient } from '../execution/client-factory';

jest.mock('../execution/client-factory', () => ({ createTargetClient: jest.fn() }));

const GiB = 1024 ** 3;

/** 10 GiB maxmemory, 2 GiB used, nothing in db0 (a flush frees nothing). */
function master(overrides: Partial<MasterMemory> = {}): MasterMemory {
  return {
    name: 'target',
    maxmemory: 10 * GiB,
    usedMemory: 2 * GiB,
    datasetMemory: 0,
    policy: 'noeviction',
    keys: 0,
    db0Keys: 0,
    expires: 0,
    slotShare: 1,
    ...overrides,
  };
}

/** Like master(), but every used byte is db0 data, so a flush frees all of it. */
function flushable(overrides: Partial<MasterMemory> = {}): MasterMemory {
  const used = overrides.usedMemory ?? 2 * GiB;
  return master({ keys: 100, db0Keys: 100, datasetMemory: used, usedMemory: used, ...overrides });
}

/** A cluster master with 4 GiB maxmemory, 1 GiB used and half the slots. */
function shard(name: string, overrides: Partial<MasterMemory> = {}): MasterMemory {
  return master({ name, maxmemory: 4 * GiB, usedMemory: GiB, slotShare: 0.5, ...overrides });
}

function target(...masters: MasterMemory[]): TargetMemory {
  const list = masters.length > 0 ? masters : [master()];
  return { masters: list, db0Keys: list.reduce((s, m) => s + m.db0Keys, 0) };
}

interface NodeSpec {
  maxmemory: number;
  used: number;
  policy: string;
  notCounted?: number;
  dataset?: number;
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
            ? `# Memory\r\nused_memory:${spec.used}\r\nused_memory_dataset:${spec.dataset ?? 0}\r\nmaxmemory:${spec.maxmemory}\r\nmaxmemory_policy:${spec.policy}\r\nmem_not_counted_for_evict:${spec.notCounted ?? 0}\r\n`
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
  it('blocks when the source does not fit even after emptying the target', () => {
    const [issue] = checkTargetCapacity(12 * GiB, target());
    expect(issue).toMatchObject({
      severity: 'blocking',
      category: 'capacity',
      title: 'Target does not have enough memory',
    });
    expect(issue.detail).toContain('8 GB free of 10 GB maxmemory');
  });

  it('blocks an already-empty target that cannot hold the source instead of saying to empty it', () => {
    const [issue] = checkTargetCapacity(10.5 * GiB, target(master({ usedMemory: GiB })));
    expect(issue.severity).toBe('blocking');
    expect(issue.detail).not.toContain('emptyDbBeforeSync');
  });

  it('treats data outside db0 as not freed by emptying the target', () => {
    const [issue] = checkTargetCapacity(
      5 * GiB,
      target(master({ usedMemory: 7 * GiB, datasetMemory: 6 * GiB, keys: 100, db0Keys: 0 })),
    );
    expect(issue.severity).toBe('blocking');
  });

  it('counts only db0 share of the dataset as freed by emptying the target', () => {
    // 6 GiB dataset, half the keys in db0: a flush frees 3 GiB, leaving 6 GiB of room.
    const m = master({ usedMemory: 7 * GiB, datasetMemory: 6 * GiB, keys: 100, db0Keys: 50 });
    expect(checkTargetCapacity(5 * GiB, target(m))[0].title).toBe(
      'Target only has room if it is emptied first',
    );
    expect(checkTargetCapacity(7 * GiB, target(m))[0].severity).toBe('blocking');
  });

  it('warns to empty first when the source fits once the target is emptied', () => {
    const [issue] = checkTargetCapacity(9 * GiB, target(flushable()));
    expect(issue).toMatchObject({
      severity: 'warning',
      category: 'capacity',
      title: 'Target only has room if it is emptied first',
    });
    expect(issue.detail).toContain('emptyDbBeforeSync');
    expect(issue.detail).toContain('10 GB would be available after emptying it');
  });

  it('keeps a 10% margin over the room after emptying before blocking, and says so', () => {
    const [marginal] = checkTargetCapacity(10.5 * GiB, target(flushable()));
    expect(marginal).toMatchObject({
      severity: 'warning',
      title: 'Target memory may not hold the source',
    });
    expect(marginal.detail).not.toContain('emptyDbBeforeSync');
    expect(checkTargetCapacity(11.5 * GiB, target(flushable()))[0].severity).toBe('blocking');
  });

  it('downgrades a blocker to a warning when the source size is only its used_memory', () => {
    const [issue] = checkTargetCapacity(12 * GiB, target(), null, { roughSourceSize: true });
    expect(issue).toMatchObject({
      severity: 'warning',
      category: 'capacity',
      title: 'Target may not have enough memory',
    });
    expect(issue.detail).toContain('used_memory');
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

  it('blocks under a volatile policy when only the target has TTL keys and the source alone exceeds maxmemory', () => {
    const [issue] = checkTargetCapacity(
      12 * GiB,
      target(master({ policy: 'volatile-lru', expires: 5 })),
      0,
    );
    expect(issue.severity).toBe('blocking');
    expect(issue.detail).toContain('the source has none');
  });

  it('warns under a volatile policy when the source has TTL keys', () => {
    expect(
      checkTargetCapacity(12 * GiB, target(master({ policy: 'volatile-lru' })), 12)[0].severity,
    ).toBe('warning');
  });

  it('warns, not blocks, under a volatile policy when the source TTL count is unknown', () => {
    expect(
      checkTargetCapacity(12 * GiB, target(master({ policy: 'volatile-lru' })), null)[0].severity,
    ).toBe('warning');
    expect(
      checkTargetCapacity(12 * GiB, target(master({ policy: 'volatile-ttl' })))[0].severity,
    ).toBe('warning');
  });

  it('blocks under a volatile policy when neither side has TTL keys to evict', () => {
    const [issue] = checkTargetCapacity(12 * GiB, target(master({ policy: 'volatile-lru' })), 0);
    expect(issue).toMatchObject({ severity: 'blocking', category: 'capacity' });
    expect(issue.detail).toContain('only evicts keys with a TTL');
  });

  it('warns to empty first under a volatile policy with no TTL keys when the source fits once emptied', () => {
    const [issue] = checkTargetCapacity(
      9 * GiB,
      target(flushable({ policy: 'volatile-lru' })),
      0,
    );
    expect(issue.title).toBe('Target only has room if it is emptied first');
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
      10 * GiB,
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
      10 * GiB,
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
    // 5.8 GiB source, 6 GiB free in total; the 80% shard needs 4.6 GiB but has 3 GiB.
    const [issue] = checkTargetCapacity(
      5.8 * GiB,
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
      10 * GiB,
      target(
        shard('10.0.0.1:6379', { policy: 'volatile-lru', expires: 0 }),
        shard('10.0.0.2:6379', { policy: 'volatile-lru', expires: 100 }),
      ),
      12,
    );
    expect(issue.severity).toBe('warning');
    const [blocked] = checkTargetCapacity(
      10 * GiB,
      target(
        shard('10.0.0.1:6379', { policy: 'volatile-lru', expires: 0 }),
        shard('10.0.0.2:6379', { policy: 'allkeys-lru' }),
      ),
      0,
    );
    expect(blocked.severity).toBe('blocking');
    expect(blocked.detail).toContain('10.0.0.1:6379');
  });

  it('names the full shard when summed free memory would have hidden it (3x10 GB, 9/5/4 used, 9 GB source)', () => {
    const third = 1 / 3;
    const [issue] = checkTargetCapacity(
      9 * GiB,
      target(
        flushable({ name: '10.0.0.1:6379', usedMemory: 9 * GiB, slotShare: third }),
        flushable({ name: '10.0.0.2:6379', usedMemory: 5 * GiB, slotShare: third }),
        flushable({ name: '10.0.0.3:6379', usedMemory: 4 * GiB, slotShare: third }),
      ),
    );
    expect(issue).toMatchObject({ severity: 'warning', title: 'Target only has room if it is emptied first' });
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

  it('talks about db0 keys', () => {
    expect(checkKeyOverlap(5000, { sampled: 200, existing: 0 })[0].detail).toContain('keys in db0');
  });

  it('only notes a non-empty target when no sampled key collides', () => {
    expect(checkKeyOverlap(5000, { sampled: 200, existing: 0 })[0]).toMatchObject({
      severity: 'info',
      title: 'Target is not empty',
    });
  });

  it('says overlap was not checked when no source keys were sampled', () => {
    expect(checkKeyOverlap(5000, { sampled: 0, existing: 0 })[0]).toMatchObject({
      severity: 'info',
      title: 'Key overlap was not checked',
    });
  });
});

describe('capacity-checker / readTargetMemory', () => {
  it('reads a standalone target and excludes memory not counted for eviction', async () => {
    const client = node({
      maxmemory: 10 * GiB,
      used: 3 * GiB,
      notCounted: GiB,
      dataset: GiB,
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
          datasetMemory: GiB,
          policy: 'allkeys-lru',
          keys: 42,
          db0Keys: 42,
          expires: 7,
          slotShare: 1,
        },
      ],
      db0Keys: 42,
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
    expect(memory.db0Keys).toBe(30);
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

describe('capacity-checker / source size and TTL helpers', () => {
  const info = '# Keyspace\r\ndb0:keys=5,expires=2,avg_ttl=0\r\ndb3:keys=10,expires=0,avg_ttl=0\r\n';
  const noTtl = '# Keyspace\r\ndb0:keys=5,expires=0,avg_ttl=0\r\n';

  it('sums keys and expires over every db', () => {
    expect(keyspaceTotals(info)).toEqual({ keys: 15, expires: 2, db0Keys: 5 });
  });

  it('returns the TTL key count, or null when nothing can vouch for "none"', () => {
    expect(sourceExpiringKeysFrom(info, false)).toBe(2);
    expect(sourceExpiringKeysFrom(noTtl, true)).toBe(0);
    expect(sourceExpiringKeysFrom(noTtl, false)).toBeNull();
    expect(sourceExpiringKeysFrom(undefined, true)).toBeNull();
  });

  it('uses the key sample when INFO shows no TTL keys', () => {
    expect(sourceExpiringKeysFrom(noTtl, false, { sampled: 200, noExpiry: 150 })).toBe(50);
    expect(sourceExpiringKeysFrom(noTtl, false, { sampled: 200, noExpiry: 200 })).toBe(0);
    expect(sourceExpiringKeysFrom(undefined, false, { sampled: 0, noExpiry: 0 })).toBeNull();
  });

  it('gives db0 share of a standalone source, and 1 for a cluster or missing INFO', () => {
    const multiDb = '# Keyspace\r\ndb0:keys=25,expires=0,avg_ttl=0\r\ndb1:keys=75,expires=0,avg_ttl=0\r\n';
    expect(sourceDb0Share(multiDb, false)).toBe(0.25);
    expect(sourceDb0Share(multiDb, true)).toBe(1);
    expect(sourceDb0Share(undefined, false)).toBe(1);
    expect(sourceDb0Share('# Keyspace\r\n', false)).toBe(1);
  });

  it('scales the estimate to db0, and flags the used_memory fallback as rough', () => {
    expect(capacitySourceSize({ estimatedBytes: 10 * GiB, db0Share: 0.5, usedMemory: 50 * GiB })).toEqual({
      bytes: 5 * GiB,
      rough: false,
    });
    expect(capacitySourceSize({ estimatedBytes: 0, db0Share: 0.5, usedMemory: 2 * GiB })).toEqual({
      bytes: 2 * GiB,
      rough: true,
    });
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

describe('capacity-checker / pickOverlapSample', () => {
  it('takes keys round-robin across source nodes', () => {
    const keys = [
      ...Array.from({ length: 300 }, (_, i) => ({ key: `a:${i}`, clientIndex: 0 })),
      ...Array.from({ length: 300 }, (_, i) => ({ key: `b:${i}`, clientIndex: 1 })),
      ...Array.from({ length: 300 }, (_, i) => ({ key: `c:${i}`, clientIndex: 2 })),
    ];
    const picked = pickOverlapSample(keys);
    expect(picked).toHaveLength(200);
    expect(picked.slice(0, 3)).toEqual(['a:0', 'b:0', 'c:0']);
    for (const prefix of ['a:', 'b:', 'c:']) {
      expect(picked.filter((k) => k.startsWith(prefix)).length).toBeGreaterThanOrEqual(66);
    }
  });

  it('fills from larger nodes when a node has few keys, and handles a missing clientIndex', () => {
    const picked = pickOverlapSample(
      [{ key: 'x' }, ...Array.from({ length: 10 }, (_, i) => ({ key: `y:${i}`, clientIndex: 1 }))],
      5,
    );
    expect(picked).toEqual(['x', 'y:0', 'y:1', 'y:2', 'y:3']);
  });
});

describe('capacity-checker / probeTargetCapacity', () => {
  it('keeps the capacity finding when the overlap check fails', async () => {
    const target = {
      ...node({ maxmemory: GiB, used: GiB, policy: 'noeviction', keys: 5 }),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    target.exists.mockRejectedValue(new Error('NOPERM this user has no permissions to run the exists command'));
    jest
      .mocked(createTargetClient)
      .mockReturnValue(target as unknown as ReturnType<typeof createTargetClient>);

    const issues = await probeTargetCapacity({
      targetConfig: {} as Parameters<typeof createTargetClient>[0],
      targetIsCluster: false,
      sourceBytes: 2 * GiB,
      sampledKeys: ['a'],
      sourceExpiringKeys: 0,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'blocking', category: 'capacity' }),
        expect.objectContaining({
          severity: 'info',
          category: 'key_overlap',
          title: 'Key-overlap check did not run',
        }),
      ]),
    );
    expect(target.quit).toHaveBeenCalled();
  });
});
