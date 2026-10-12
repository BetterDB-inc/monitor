import { estimate } from '../size-estimator';
import { sampleNodes, SamplerUnsupportedError, TARGET_RELATIVE_CI } from '../stratified-sampler';
import { fakeClient, keyspace } from './fake-keyspace';

const string = (size = 100) => ({ type: 'string', size });
const hash = (index: number) => ({ type: 'hash', size: 1000 + (index % 7) * 150 });

describe('sampleNodes', () => {
  it('enumerates a small keyspace exactly in the pilot', async () => {
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keyspace(50, () => string())) }], { budget: 4000, deadlineMs: 60_000 });
    expect(result.exhausted).toBe(true);
    expect(result.strata).toEqual([{ type: 'string', estimatedKeys: 50, exact: true, observed: 50, sizes: Array(50).fill(100) }]);
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
    expect(hashes.exact).toBe(true);
    expect(strings.sizes).toHaveLength(192);
    expect(strings.estimatedKeys).toBe(1000);
    expect(strings.exact).toBe(true);
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

  it('keeps the census estimate when the TYPE scan stops early', async () => {
    const keys = keyspace(3000, (index) => ((index < 200 ? index % 10 === 0 : index % 5 === 0) ? hash(index) : string()));
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 100, deadlineMs: 60_000 });
    const hashes = result.strata.find((stratum) => stratum.type === 'hash')!;
    expect(hashes.exact).toBe(false);
    expect(hashes.observed).toBe(180);
    expect(hashes.estimatedKeys).toBeCloseTo((180 / 1000) * 3000, 6);
  });

  it('counts types exactly when the census covers the whole keyspace', async () => {
    const keys = keyspace(1500, (index) => (index % 5 === 0 ? hash(index) : string()));
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 200, deadlineMs: 60_000 });
    expect(result.strata.every((stratum) => stratum.exact)).toBe(true);
    expect(result.strata.find((stratum) => stratum.type === 'hash')!.estimatedKeys).toBe(300);
    expect(result.strata.find((stratum) => stratum.type === 'string')!.estimatedKeys).toBe(1200);
    expect(result.strata.reduce((sum, stratum) => sum + stratum.estimatedKeys, 0)).toBe(1500);
  });

  it('renormalises a partial census to the database size', async () => {
    const keys = keyspace(6000, (index) => (index % 3 === 0 ? hash(index) : string()));
    const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 200, deadlineMs: 60_000 });
    expect(result.strata.some((stratum) => !stratum.exact)).toBe(true);
    expect(result.strata.every((stratum) => stratum.observed > 0)).toBe(true);
    expect(result.strata.reduce((sum, stratum) => sum + stratum.estimatedKeys, 0)).toBeCloseTo(6000, 6);
  });

  describe('adaptive extension', () => {
    const heavyTail = () => keyspace(20_000, (index) => ({ type: 'string', size: index % 200 === 0 ? 100_000 : 100 }));
    const sampledOf = (strata: { sizes: number[] }[]) => strata.reduce((sum, stratum) => sum + stratum.sizes.length, 0);

    it('samples beyond the budget until the interval is tight', async () => {
      const [result] = await sampleNodes([{ name: 'a', client: fakeClient(heavyTail()) }], { budget: 400, hardCap: 20_000, deadlineMs: 60_000 });
      const { totalBytes, ci95Bytes } = estimate([result], 0);
      expect(sampledOf(result.strata)).toBeGreaterThan(400);
      expect(ci95Bytes / totalBytes <= TARGET_RELATIVE_CI || sampledOf(result.strata) === 20_000).toBe(true);
    });

    it('never exceeds its share of the hard cap', async () => {
      const [result] = await sampleNodes([{ name: 'a', client: fakeClient(heavyTail()) }], { budget: 400, hardCap: 1000, deadlineMs: 60_000 });
      expect(sampledOf(result.strata)).toBeLessThanOrEqual(1000);
      expect(sampledOf(result.strata)).toBeGreaterThan(400);
    });

    it('stops at the budget when the interval is already tight', async () => {
      const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keyspace(20_000, () => string())) }], {
        budget: 400,
        hardCap: 20_000,
        deadlineMs: 60_000,
      });
      expect(sampledOf(result.strata)).toBe(400);
    });

    it('never exceeds the budget without a hard cap', async () => {
      const [result] = await sampleNodes([{ name: 'a', client: fakeClient(heavyTail()) }], { budget: 400, deadlineMs: 60_000 });
      expect(sampledOf(result.strata)).toBeLessThanOrEqual(400);
    });
  });
});
