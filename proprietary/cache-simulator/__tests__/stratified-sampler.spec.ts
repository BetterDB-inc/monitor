import { DICT_ENTRY_BYTES, estimate, keyMemoryCeiling } from '../size-estimator';
import { sampleNodes, HEAVY_TAIL_MIN_SAMPLES, SamplerUnsupportedError, TARGET_RELATIVE_CI } from '../stratified-sampler';
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
    expect(strings.sizes.length).toBeGreaterThanOrEqual(30);
    expect(strings.sizes.length + hashes.sizes.length).toBeLessThanOrEqual(400);
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
    expect(hashes.observed).toBeGreaterThan(0);
    expect(hashes.estimatedKeys).toBeCloseTo((hashes.observed / 1000) * 3000, 6);
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

  it('never estimates fewer keys than the census saw when DBSIZE is stale', async () => {
    const keys = keyspace(6000, (index) => (index % 3 === 0 ? hash(index) : string()));
    const client = { ...fakeClient(keys), getDbSize: async () => 1000 };
    const [result] = await sampleNodes([{ name: 'a', client }], { budget: 200, deadlineMs: 60_000 });
    for (const stratum of result.strata) expect(stratum.estimatedKeys).toBeGreaterThanOrEqual(stratum.observed);
    expect(result.strata.every((stratum) => stratum.estimatedKeys > 0)).toBe(true);
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

    it('keeps extending to full enumeration when a narrow interval is untrustworthy', async () => {
      const keys = keyspace(1000, (index) => ({ type: 'string', size: index % 50 === 0 ? 160 : 100 }));
      const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 100, hardCap: 1000, deadlineMs: 60_000 });
      const final = estimate([result], 0);
      expect(sampledOf(result.strata)).toBe(1000);
      expect(final.ci95Bytes).toBe(0);
      expect(final.totalBytes).toBe(980 * 100 + 20 * 160);
    });

    it('keeps extending a heavy-tailed stratum below the minimum even when the interval is tight', async () => {
      const keys = keyspace(30_000, (index) => ({ type: 'string', size: index % 50 === 0 ? 160 : 100 }));
      const [early] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 400, deadlineMs: 60_000 });
      const earlyEstimate = estimate([early], 0);
      expect(earlyEstimate.ci95Bytes / earlyEstimate.totalBytes).toBeLessThanOrEqual(TARGET_RELATIVE_CI);
      const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys) }], { budget: 400, hardCap: 30_000, deadlineMs: 60_000 });
      expect(sampledOf(result.strata)).toBeGreaterThanOrEqual(HEAVY_TAIL_MIN_SAMPLES);
      expect(sampledOf(result.strata)).toBeLessThanOrEqual(30_000);
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

    it('resumes the TYPE scan across rounds instead of restarting it', async () => {
      const keys = heavyTail();
      const client = fakeClient(keys);
      const call = client.call;
      let typeScans = 0;
      client.call = (command: string, args: string[]) => {
        if (args.includes('TYPE')) typeScans += 1;
        return call(command, args);
      };
      const [result] = await sampleNodes([{ name: 'a', client }], { budget: 400, hardCap: 10_000, deadlineMs: 60_000 });
      expect(sampledOf(result.strata)).toBeGreaterThan(4000);
      expect(typeScans).toBeLessThanOrEqual(keys.size / 1000 + 1);
    });
  });

  describe('large keys the sample misses', () => {
    const huge = 2 * 1024 * 1024;
    const sampledOf = (strata: { sizes: number[] }[]) => strata.reduce((sum, stratum) => sum + stratum.sizes.length, 0);
    const runs = Array.from({ length: 10 }, (_, index) => index + 1);
    const withHiddenHashes = (strings: (index: number) => number) =>
      keyspace(20_000, (index) => (index % 10 !== 0 ? string(strings(index)) : { type: 'hash', size: index % 3_000 === 0 ? huge : 500 }));
    const scenarios = [
      { name: 'uniform strings', keys: withHiddenHashes((index) => 50 + ((index * 7919) % 1000)) },
      { name: 'heavy-tailed strings', keys: withHiddenHashes((index) => (index % 201 === 0 ? 100_000 : 50 + (index % 100))) },
    ];

    it.each(scenarios)('finds the large keys hidden in a uniform-looking type among $name', async ({ keys }) => {
      const truth = [...keys.values()].reduce((sum, key) => sum + (key.size ?? 0), 0);
      const ceiling = keyMemoryCeiling(truth - keys.size * DICT_ENTRY_BYTES, keys.size);
      const hugeCount = [...keys.values()].filter((key) => key.size === huge).length;
      for (const seed of runs) {
        const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys, { seed }), ceiling }], {
          budget: 400,
          hardCap: 10_000,
          deadlineMs: 60_000,
        });
        const hashes = result.strata.find((stratum) => stratum.type === 'hash')!;
        const final = estimate([result], 0);
        expect(result.ceiling).toBe(ceiling);
        expect(hashes.sizes.filter((size) => size === huge)).toHaveLength(hugeCount);
        expect(final.likelyMissedLargeKeys).toBe(false);
        expect(Math.abs(final.totalBytes - truth)).toBeLessThanOrEqual(final.ci95Bytes);
      }
    });

    it('stops at the budget when the sample explains the dataset memory', async () => {
      const plain = keyspace(20_000, () => string());
      const [result] = await sampleNodes([{ name: 'a', client: fakeClient(plain), ceiling: 20_000 * 100 }], {
        budget: 400,
        hardCap: 20_000,
        deadlineMs: 60_000,
      });
      expect(sampledOf(result.strata)).toBe(400);
    });

    it('does not chase the gap when other databases share the dataset memory', async () => {
      const plain = keyspace(20_000, () => string());
      const [result] = await sampleNodes([{ name: 'a', client: fakeClient(plain), ceiling: 20_000 * 100 * 3, otherDbKeys: true }], {
        budget: 400,
        hardCap: 20_000,
        deadlineMs: 60_000,
      });
      expect(sampledOf(result.strata)).toBe(400);
      expect(result.otherDbKeys).toBe(true);
      expect(estimate([result], 0).likelyMissedLargeKeys).toBe(false);
    });
  });

  describe('rare dominating key', () => {
    const giant = 512 * 1024 * 1024;
    const keys = keyspace(50_000, (index) => (index === 31_337 ? string(giant) : string()));
    const truth = 49_999 * 100 + giant;
    const runs = Array.from({ length: 20 }, (_, index) => index + 1);

    it('covers the true size with the memory ceiling on every scan order', async () => {
      for (const seed of runs) {
        const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys, { seed }) }], { budget: 4000, hardCap: 50_000, deadlineMs: 60_000 });
        const { totalBytes, ci95Bytes } = estimate([{ ...result, ceiling: truth + 1024 * 1024 }], 0);
        expect(Math.abs(totalBytes - truth)).toBeLessThanOrEqual(ci95Bytes);
      }
    });

    it('misses the key on some scan orders, so the sample alone cannot bound it', async () => {
      let missed = 0;
      for (const seed of runs) {
        const [result] = await sampleNodes([{ name: 'a', client: fakeClient(keys, { seed }) }], { budget: 4000, hardCap: 50_000, deadlineMs: 60_000 });
        if (!result.strata.some((stratum) => stratum.sizes.includes(giant))) missed += 1;
      }
      expect(missed).toBeGreaterThan(0);
    });
  });
});
