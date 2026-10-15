import { mergeKeySizeDistributions, parseKeySizeDistribution } from '@betterdb/shared';

describe('parseKeySizeDistribution', () => {
  it('parses a normal reply into per-db distributions', () => {
    const raw = [
      '# Keysizes',
      'db0_distrib_strings_sizes:1=19,2=655,4=3918,16K=3',
      'db0_distrib_lists_items:1=5,8=2',
    ].join('\r\n');

    const result = parseKeySizeDistribution(raw);

    expect(result.available).toBe(true);
    expect(result.databases.db0.strings).toEqual({
      metric: 'sizes',
      buckets: [
        { bucket: '1', count: 19 },
        { bucket: '2', count: 655 },
        { bucket: '4', count: 3918 },
        { bucket: '16K', count: 3 },
      ],
    });
    expect(result.databases.db0.lists.metric).toBe('items');
  });

  it('treats a header-only reply (supported server, empty keyspace) as available with no databases', () => {
    expect(parseKeySizeDistribution('# Keysizes\r\n')).toEqual({ databases: {}, available: true });
    // Tolerate \n-only and a trailing CRLF.
    expect(parseKeySizeDistribution('#Keysizes\n').available).toBe(true);
  });

  it('treats an empty reply (unsupported server) as unavailable', () => {
    expect(parseKeySizeDistribution('')).toEqual({ databases: {}, available: false });
    expect(parseKeySizeDistribution('\r\n\r\n')).toEqual({ databases: {}, available: false });
  });

  it('infers availability from distribution lines even without a header', () => {
    const result = parseKeySizeDistribution('db1_distrib_sets_items:1=3');
    expect(result.available).toBe(true);
    expect(result.databases.db1.sets.buckets).toEqual([{ bucket: '1', count: 3 }]);
  });
});

describe('mergeKeySizeDistributions', () => {
  it('ORs availability across nodes', () => {
    const merged = mergeKeySizeDistributions([
      { databases: {}, available: false },
      { databases: {}, available: true },
    ]);
    expect(merged.available).toBe(true);
  });

  it('sums buckets for the same db/type across nodes', () => {
    const merged = mergeKeySizeDistributions([
      { databases: { db0: { strings: { metric: 'sizes', buckets: [{ bucket: '1', count: 2 }] } } }, available: true },
      {
        databases: {
          db0: {
            strings: { metric: 'sizes', buckets: [{ bucket: '1', count: 3 }, { bucket: '16K', count: 1 }] },
          },
        },
        available: true,
      },
    ]);

    expect(merged.available).toBe(true);
    expect(merged.databases.db0.strings.buckets).toEqual([
      { bucket: '1', count: 5 },
      { bucket: '16K', count: 1 },
    ]);
  });
});
