import Valkey, { Cluster } from 'iovalkey';
import {
  checkKeyOverlap,
  checkTargetCapacity,
  readTargetMemory,
  sampleKeyOverlap,
  type TargetMemory,
} from '../analysis/capacity-checker';

const GiB = 1024 ** 3;

function target(overrides: Partial<TargetMemory> = {}): TargetMemory {
  return { maxmemory: 10 * GiB, usedMemory: 2 * GiB, policy: 'noeviction', keys: 0, ...overrides };
}

function node(memory: { maxmemory: number; used: number; policy: string }, keys: number) {
  return {
    info: jest
      .fn()
      .mockImplementation((section: string) =>
        Promise.resolve(
          section === 'memory'
            ? `# Memory\r\nused_memory:${memory.used}\r\nmaxmemory:${memory.maxmemory}\r\nmaxmemory_policy:${memory.policy}\r\n`
            : `# Keyspace\r\ndb0:keys=${keys},expires=0,avg_ttl=0\r\n`,
        ),
      ),
    exists: jest.fn(),
  };
}

describe('capacity-checker / checkTargetCapacity', () => {
  it('blocks when the dataset does not fit and the target cannot evict', () => {
    const [issue] = checkTargetCapacity(9 * GiB, target());
    expect(issue).toMatchObject({ severity: 'blocking', category: 'capacity' });
    expect(issue.detail).toContain('8 GB free of 10 GB maxmemory');
  });

  it('blocks when masters disagree on the eviction policy', () => {
    expect(checkTargetCapacity(9 * GiB, target({ policy: 'mixed' }))[0].severity).toBe('blocking');
  });

  it('warns about eviction instead of blocking under an allkeys policy', () => {
    const [issue] = checkTargetCapacity(9 * GiB, target({ policy: 'allkeys-lru' }));
    expect(issue).toMatchObject({
      severity: 'warning',
      title: 'Target will evict data during migration',
    });
    expect(issue.detail).toContain('evict about 1 GB');
  });

  it('mentions OOM once TTL keys run out under a volatile policy', () => {
    expect(checkTargetCapacity(9 * GiB, target({ policy: 'volatile-lru' }))[0].detail).toContain(
      'fail with OOM',
    );
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
    expect(checkTargetCapacity(100 * GiB, target({ maxmemory: 0 }))).toEqual([]);
    expect(checkTargetCapacity(0, target())).toEqual([]);
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
  it('reads a standalone target', async () => {
    const client = node(
      { maxmemory: 10 * GiB, used: 2 * GiB, policy: 'allkeys-lru' },
      42,
    ) as unknown as Valkey;
    expect(await readTargetMemory(client)).toEqual({
      maxmemory: 10 * GiB,
      usedMemory: 2 * GiB,
      policy: 'allkeys-lru',
      keys: 42,
    });
  });

  it('sums every master of a cluster target', async () => {
    const cluster = Object.create(Cluster.prototype) as Cluster;
    cluster.nodes = jest
      .fn()
      .mockReturnValue([
        node({ maxmemory: 4 * GiB, used: GiB, policy: 'noeviction' }, 10),
        node({ maxmemory: 4 * GiB, used: GiB, policy: 'noeviction' }, 20),
      ]) as unknown as Cluster['nodes'];

    expect(await readTargetMemory(cluster as unknown as Valkey)).toEqual({
      maxmemory: 8 * GiB,
      usedMemory: 2 * GiB,
      policy: 'noeviction',
      keys: 30,
    });
    expect(cluster.nodes).toHaveBeenCalledWith('master');
  });

  it('treats a cluster as unlimited when any master has no maxmemory, and flags mixed policies', async () => {
    const cluster = Object.create(Cluster.prototype) as Cluster;
    cluster.nodes = jest
      .fn()
      .mockReturnValue([
        node({ maxmemory: 4 * GiB, used: GiB, policy: 'noeviction' }, 0),
        node({ maxmemory: 0, used: GiB, policy: 'allkeys-lru' }, 0),
      ]) as unknown as Cluster['nodes'];

    expect(await readTargetMemory(cluster as unknown as Valkey)).toMatchObject({
      maxmemory: 0,
      policy: 'mixed',
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
