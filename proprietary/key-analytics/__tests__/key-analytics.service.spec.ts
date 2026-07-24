import { KeyAnalyticsService } from '../key-analytics.service';
import type { HotKeyEntry, HotKeyQueryOptions } from '@betterdb/shared';

function hotKey(over: Partial<HotKeyEntry>): HotKeyEntry {
  return {
    id: 'id',
    keyName: 'k',
    connectionId: 'c1',
    capturedAt: 0,
    signalType: 'composite',
    rank: 1,
    ...over,
  };
}

function makeService(getHotKeys: jest.Mock): KeyAnalyticsService {
  const storage = { getHotKeys } as any;
  const registry = {} as any;
  const license = { hasFeature: () => true, getLicenseTier: () => 'pro' } as any;
  return new KeyAnalyticsService(registry, storage, license);
}

const isCompositeOnly = (opts: HotKeyQueryOptions) =>
  opts.signalTypes?.length === 1 && opts.signalTypes[0] === 'composite';

describe('KeyAnalyticsService.getCompositeKeys freshness guard', () => {
  it('returns the composite batch when it is from the latest collection', async () => {
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts)
        ? [hotKey({ capturedAt: 1000, keyName: 'a' })]
        : [hotKey({ capturedAt: 1000, signalType: 'cardinality' })],
    );

    const res = await makeService(getHotKeys).getCompositeKeys({ connectionId: 'c1', latest: true });

    expect(res.map((r) => r.keyName)).toEqual(['a']);
  });

  it('returns empty when a newer collection produced no composite keys', async () => {
    const getHotKeys = jest.fn(async (opts: HotKeyQueryOptions) =>
      isCompositeOnly(opts)
        ? [hotKey({ capturedAt: 1000, keyName: 'stale' })] // old composite batch
        : [hotKey({ capturedAt: 2000, signalType: 'cardinality' })], // newer scan, no composites
    );

    const res = await makeService(getHotKeys).getCompositeKeys({ connectionId: 'c1', latest: true });

    expect(res).toEqual([]);
  });

  it('does not apply the freshness guard for explicit time ranges', async () => {
    const getHotKeys = jest.fn(async () => [hotKey({ capturedAt: 1000, keyName: 'ranged' })]);

    const service = makeService(getHotKeys);
    const res = await service.getCompositeKeys({
      connectionId: 'c1',
      latest: true,
      startTime: 1,
      endTime: 5,
    });

    expect(res.map((r) => r.keyName)).toEqual(['ranged']);
    // No second lookup for the latest-collection timestamp.
    expect(getHotKeys).toHaveBeenCalledTimes(1);
  });
});
