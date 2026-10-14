import { cloneElement, type ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { KvCacheFootprintSnapshot, KvCacheSampleBucket } from '@betterdb/shared';

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 600, height: 260 }),
  };
});

import { KvCacheCharts } from '../KvCacheCharts';

const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct';

const bucket = (timestamp: number, hitRate: number): KvCacheSampleBucket =>
  ({
    engineId: 'e1',
    modelName: MODEL,
    timestamp,
    requestedTokens: 100,
    hitTokens: hitRate * 100,
    lookupTokens: 0,
    lookupHits: 0,
    remoteReadBytes: 0,
    remoteWriteBytes: 0,
    remoteReadRequests: 0,
    remoteWriteRequests: 0,
    remotePingErrors: 0,
    hitRate,
  }) as KvCacheSampleBucket;

const snapshot = (timestamp: number, bytesEst: number) =>
  ({ timestamp, perModel: [{ model: MODEL, dtype: 'bfloat16', chunksEst: 1, bytesEst }] }) as unknown as KvCacheFootprintSnapshot;

const drawn = (container: HTMLElement, selector: string) =>
  [...container.querySelectorAll(selector)].filter((path) => (path.getAttribute('d') ?? '').length > 0).length;

describe('KvCacheCharts', () => {
  it('plots series whose model names contain dots', () => {
    const { container } = render(
      <KvCacheCharts
        buckets={[bucket(60_000, 0.5), bucket(120_000, 0.7)]}
        history={[snapshot(60_000, 1000), snapshot(120_000, 2000)]}
        engines={[]}
      />,
    );
    expect(drawn(container, '.recharts-line-curve')).toBeGreaterThanOrEqual(2);
    expect(drawn(container, '.recharts-area-area')).toBe(1);
  });
});
