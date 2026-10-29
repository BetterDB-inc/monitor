import Valkey, { Cluster } from 'iovalkey';
import { splitSampleBudget, validateSample } from '../validation/sample-validator';

/** A standalone node holding string keys; `values` maps key -> value. */
function node(values: Record<string, string>) {
  const keys = Object.keys(values);
  return {
    has: (key: string) => key in values,
    read: (key: string) => (key in values ? Buffer.from(values[key]) : null),
    dbsize: jest.fn().mockResolvedValue(keys.length),
    // One SCAN page with every key, so sampling is deterministic.
    scan: jest.fn().mockResolvedValue(['0', keys]),
    pipeline: jest.fn(() => {
      const queued: string[] = [];
      interface Pipe {
        type: (key: string) => Pipe;
        exec: () => Promise<Array<[null, string]>>;
      }
      const pipe: Pipe = {
        type: (key: string) => {
          queued.push(key);
          return pipe;
        },
        exec: async () => queued.map((key) => [null, key in values ? 'string' : 'none']),
      };
      return pipe;
    }),
    type: jest.fn(async (key: string) => (key in values ? 'string' : 'none')),
    getBuffer: jest.fn(async (key: string) => (key in values ? Buffer.from(values[key]) : null)),
  };
}

/** Reads route to whichever master holds the key, as the real Cluster client does. */
function cluster(masters: Array<ReturnType<typeof node>>) {
  const owner = (key: string) => masters.find((master) => master.has(key));
  const client = Object.create(Cluster.prototype) as Cluster;
  client.nodes = jest.fn().mockReturnValue(masters) as unknown as Cluster['nodes'];
  const reads = {
    type: jest.fn(async (key: string) => (owner(key) ? 'string' : 'none')),
    getBuffer: jest.fn(async (key: string) => owner(key)?.read(key) ?? null),
  };
  Object.assign(client, reads);
  return Object.assign(client as unknown as Valkey, reads);
}

function shard(prefix: string, count: number): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < count; i++) values[`${prefix}:${i}`] = `v-${prefix}-${i}`;
  return values;
}

describe('splitSampleBudget', () => {
  it('splits by key count and adds up to the budget', () => {
    expect(splitSampleBudget(500, [1000, 1000, 2000])).toEqual([125, 125, 250]);
  });

  it('gives every non-empty node at least one sample', () => {
    const quotas = splitSampleBudget(10, [1_000_000, 3, 0]);
    expect(quotas[1]).toBeGreaterThanOrEqual(1);
    expect(quotas[2]).toBe(0);
    expect(quotas.reduce((sum, q) => sum + q, 0)).toBe(10);
  });

  it('never asks a node for more keys than it holds', () => {
    expect(splitSampleBudget(500, [2, 3, 1])).toEqual([2, 3, 1]);
  });

  it('falls back to a plain proportional split when the budget is below the node count', () => {
    const quotas = splitSampleBudget(2, [100, 1, 1, 1]);
    expect(quotas.reduce((sum, q) => sum + q, 0)).toBe(2);
    expect(quotas[0]).toBeGreaterThanOrEqual(1);
  });

  it('returns zeros for an empty dataset or a zero budget', () => {
    expect(splitSampleBudget(500, [0, 0])).toEqual([0, 0]);
    expect(splitSampleBudget(0, [10, 10])).toEqual([0, 0]);
  });
});

describe('validateSample / cluster source', () => {
  it('SCANs every master and reads values through the cluster client', async () => {
    const a = shard('a', 4);
    const b = shard('b', 4);
    const c = shard('c', 4);
    const masters = [node(a), node(b), node(c)];
    const target = node({ ...a, ...b, ...c });
    const source = cluster(masters);

    const result = await validateSample(source, target as unknown as Valkey, 12);

    expect(result).toMatchObject({ sampledKeys: 12, matched: 12, missing: 0 });
    for (const master of masters) {
      expect(master.scan).toHaveBeenCalled();
      expect(master.getBuffer).not.toHaveBeenCalled();
    }
    expect((source.getBuffer as jest.Mock).mock.calls).toHaveLength(12);
  });

  it('follows a redirect instead of reporting a missing key', async () => {
    const a = shard('a', 3);
    const b = shard('b', 3);
    const masters = [node(a), node(b)];
    const moved = new Error('MOVED 1234 10.0.0.9:6379');
    for (const master of masters) {
      master.getBuffer.mockRejectedValue(moved);
      master.type.mockRejectedValue(moved);
    }
    const target = node({ ...a, ...b });

    const result = await validateSample(cluster(masters), target as unknown as Valkey, 6);

    expect(result.missing).toBe(0);
    expect(result.matched).toBe(result.sampledKeys);
    expect(result.sampledKeys).toBe(6);
  });

  it('rejects when a TYPE request through the cluster client fails', async () => {
    const a = shard('a', 3);
    const source = cluster([node(a)]);
    (source.type as jest.Mock).mockRejectedValueOnce(new Error('Too many Cluster redirections'));

    await expect(validateSample(source, node(a) as unknown as Valkey, 3)).rejects.toThrow(
      'Too many Cluster redirections',
    );
  });

  it('catches a shard that never reached the target', async () => {
    const a = shard('a', 4);
    const b = shard('b', 4);
    const c = shard('c', 4);
    // Shard c is absent on the target.
    const target = node({ ...a, ...b });

    const result = await validateSample(
      cluster([node(a), node(b), node(c)]),
      target as unknown as Valkey,
      12,
    );

    expect(result.missing).toBe(4);
    expect(result.issues.map((issue) => issue.key).sort()).toEqual(['c:0', 'c:1', 'c:2', 'c:3']);
  });

  it('skips SCAN on an empty master', async () => {
    const empty = node({});
    const full = node(shard('a', 3));

    const result = await validateSample(
      cluster([empty, full]),
      node(shard('a', 3)) as unknown as Valkey,
      10,
    );

    expect(empty.scan).not.toHaveBeenCalled();
    expect(result.matched).toBe(3);
  });

  it('fails loudly when the cluster client has no masters', async () => {
    await expect(validateSample(cluster([]), node({}) as unknown as Valkey, 10)).rejects.toThrow(
      'No cluster masters available to sample keys',
    );
  });
});
