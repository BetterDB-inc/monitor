import { sampleNodes, SamplerUnsupportedError } from '../stratified-sampler';
import { fakeClient, keyspace } from './fake-keyspace';

const string = (size = 100) => ({ type: 'string', size });
const hash = (index: number) => ({ type: 'hash', size: 1000 + (index % 7) * 150 });

describe('sampleNodes', () => {
  it('enumerates a small keyspace exactly in the pilot', async () => {
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keyspace(50, () => string())) }], { budget: 4000, deadlineMs: 60_000 });
    expect(result.exhausted).toBe(true);
    expect(result.strata).toEqual([{ type: 'string', estimatedKeys: 50, sizes: Array(50).fill(100) }]);
  });

  it('returns no strata for an empty keyspace', async () => {
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(new Map()) }], { budget: 4000, deadlineMs: 60_000 });
    expect(result.strata).toEqual([]);
    expect(result.dbSize).toBe(0);
  });

  it('tops up the high-variance type and counts it exactly when the TYPE scan completes', async () => {
    const keys = keyspace(1040, (index) => (index % 26 === 0 ? hash(index) : string()));
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 400, deadlineMs: 60_000 });
    const hashes = result.strata.find((stratum) => stratum.type === 'hash')!;
    const strings = result.strata.find((stratum) => stratum.type === 'string')!;
    expect(hashes.estimatedKeys).toBe(40);
    expect(hashes.sizes).toHaveLength(40);
    expect(strings.sizes).toHaveLength(192);
    expect(strings.estimatedKeys).toBeCloseTo(1040 * (192 / 200), 6);
  });

  it('keeps the total near the budget on a large keyspace', async () => {
    const keys = keyspace(5500, (index) => (index % 11 === 0 ? hash(index) : string()));
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 1000, deadlineMs: 60_000 });
    const sampled = result.strata.reduce((sum, stratum) => sum + stratum.sizes.length, 0);
    expect(sampled).toBeLessThanOrEqual(1000);
    expect(result.strata.find((stratum) => stratum.type === 'hash')!.sizes.length).toBeGreaterThanOrEqual(30);
    expect(result.strata.reduce((sum, stratum) => sum + stratum.estimatedKeys, 0)).toBeGreaterThan(5000);
  });

  it('skips keys deleted while sampling', async () => {
    const keys = keyspace(10, (index) => ({ type: 'string', size: index < 3 ? null : 100 }));
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 4000, deadlineMs: 60_000 });
    expect(result.strata[0].sizes).toHaveLength(7);
  });

  it('splits the budget across nodes by key count', async () => {
    const results = await sampleNodes(
      [
        { name: 'a', client: fakeClient(keyspace(1000, () => string())) },
        { name: 'b', client: fakeClient(keyspace(3000, () => string())) },
      ],
      { budget: 400, deadlineMs: 60_000 },
    );
    expect(results.map((result) => result.strata[0].sizes.length)).toEqual([100, 300]);
  });

  it('reports progress up to the final count', async () => {
    const progress: number[] = [];
    await sampleNodes([{ name: 'a', client: fakeClient(keyspace(250, () => string())) }], {
      budget: 4000,
      deadlineMs: 60_000,
      onProgress: (sampled) => progress.push(sampled),
    });
    expect(progress[progress.length - 1]).toBe(250);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('stops at the deadline and marks the node timed out', async () => {
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keyspace(100, () => string())) }], { budget: 4000, deadlineMs: 0 });
    expect(result.timedOut).toBe(true);
  });

  it('fails clearly when MEMORY USAGE is unavailable', async () => {
    const client = fakeClient(keyspace(10, () => string()), { memoryError: "ERR unknown command 'MEMORY'" });
    await expect(sampleNodes([{ name: 'a', client }], { budget: 4000, deadlineMs: 60_000 })).rejects.toBeInstanceOf(SamplerUnsupportedError);
  });

  it('fails clearly when SCAN TYPE is unavailable', async () => {
    const keys = keyspace(1040, (index) => (index % 26 === 0 ? hash(index) : string()));
    const client = fakeClient(keys, { scanTypeError: 'ERR syntax error' });
    await expect(sampleNodes([{ name: 'a', client }], { budget: 400, deadlineMs: 60_000 })).rejects.toBeInstanceOf(SamplerUnsupportedError);
  });

  it('rethrows other MEMORY USAGE errors without marking them unsupported', async () => {
    const client = fakeClient(keyspace(10, () => string()), { memoryError: 'LOADING Valkey is loading the dataset in memory' });
    const failure = await sampleNodes([{ name: 'a', client }], { budget: 4000, deadlineMs: 60_000 }).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SamplerUnsupportedError);
    expect(failure.message).toBe('LOADING Valkey is loading the dataset in memory');
  });

  it('throws when the pipeline returns no replies', async () => {
    const client = fakeClient(keyspace(10, () => string()));
    (client.getClient as unknown as () => unknown) = () => ({ pipeline: () => ({ call: function () { return this; }, exec: async () => null }) });
    await expect(sampleNodes([{ name: 'a', client }], { budget: 4000, deadlineMs: 60_000 })).rejects.toThrow('Pipeline returned no replies');
  });

  it('keeps the estimated count when the TYPE scan stops early', async () => {
    const keys = keyspace(3000, (index) => ((index < 200 ? index % 10 === 0 : index % 5 === 0) ? hash(index) : string()));
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 400, deadlineMs: 60_000 });
    const hashes = result.strata.find((stratum) => stratum.type === 'hash')!;
    expect(hashes.sizes).toHaveLength(220);
    expect(hashes.estimatedKeys).toBeCloseTo((20 / 200) * 3000, 6);
  });
});
