import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { KvCacheEngine, KvCacheFootprintSnapshot } from '@betterdb/shared';
import { KvCacheCards } from '../KvCacheCards';

const snapshot = (overrides: Partial<KvCacheFootprintSnapshot>) =>
  ({
    timestamp: 0,
    sampledKeys: 10,
    chunksEst: 0,
    bytesEst: 0,
    maxmemory: 0,
    maxmemoryPolicy: 'allkeys-lru',
    lmcacheMemoryShare: 0,
    noTtlRatio: 0,
    ...overrides,
  }) as KvCacheFootprintSnapshot;

const engine = { id: 'e1', name: 'vllm' } as KvCacheEngine;

const cardText = (title: string) =>
  screen.getByText(title).parentElement?.parentElement?.textContent ?? '';

describe('KvCacheCards', () => {
  it('shows TTL coverage when keys were sampled', () => {
    render(
      <KvCacheCards
        latest={snapshot({ noTtlRatio: 0.25 })}
        history={[]}
        engines={[]}
        recentHitRate={null}
        recentBuckets={[]}
      />,
    );
    expect(cardText('TTL coverage')).toContain('75.0%');
  });

  it('shows TTL coverage when MEMORY USAGE could not size the samples', () => {
    render(
      <KvCacheCards
        latest={snapshot({ sampledKeys: 0, noTtlRatio: 0.25 })}
        history={[]}
        engines={[]}
        recentHitRate={null}
        recentBuckets={[]}
      />,
    );
    expect(cardText('TTL coverage')).toContain('75.0%');
  });

  it('shows an empty TTL coverage when no TTL data was collected', () => {
    render(
      <KvCacheCards
        latest={snapshot({ sampledKeys: 0, noTtlRatio: null })}
        history={[]}
        engines={[]}
        recentHitRate={null}
        recentBuckets={[]}
      />,
    );
    expect(cardText('TTL coverage')).toContain('—');
    expect(cardText('TTL coverage')).not.toContain('100.0%');
  });

  it('renders hit rate from engine samples without a footprint snapshot', () => {
    render(
      <KvCacheCards
        latest={null}
        history={[]}
        engines={[engine]}
        recentHitRate={0.5}
        recentBuckets={[]}
      />,
    );
    expect(cardText('Hit rate (15 min)')).toContain('50.0%');
    expect(cardText('Footprint')).toContain('No footprint snapshot yet');
    expect(cardText('TTL coverage')).toContain('—');
  });

  it('shows an unknown footprint size when MEMORY USAGE answered for no sample', () => {
    render(
      <KvCacheCards
        latest={snapshot({ chunksEst: 1200, bytesEst: null, lmcacheMemoryShare: null, maxmemory: 1000 })}
        history={[]}
        engines={[]}
        recentHitRate={null}
        recentBuckets={[]}
      />,
    );
    const footprint = cardText('Footprint');
    expect(footprint).toContain('Unknown');
    expect(footprint).toContain('MEMORY USAGE unavailable');
    expect(footprint).not.toContain('0 B');
    expect(footprint).not.toContain('of maxmemory');
  });

  it('says how many shards a partial footprint was estimated from', () => {
    render(
      <KvCacheCards
        latest={snapshot({ chunksEst: 600, bytesEst: 6000, maxmemory: 1000, primariesScanned: 1, primariesTotal: 6 })}
        history={[]}
        engines={[]}
        recentHitRate={null}
        recentBuckets={[]}
      />,
    );
    const footprint = cardText('Footprint');
    expect(footprint).toContain('1 of 6 shards');
    expect(footprint).not.toContain('of maxmemory');
  });

  it('does not mention shards when every primary was scanned', () => {
    render(
      <KvCacheCards
        latest={snapshot({ chunksEst: 600, bytesEst: 500, maxmemory: 1000, primariesScanned: 3, primariesTotal: 3 })}
        history={[]}
        engines={[]}
        recentHitRate={null}
        recentBuckets={[]}
      />,
    );
    const footprint = cardText('Footprint');
    expect(footprint).not.toContain('shards');
    expect(footprint).toContain('of maxmemory');
  });

  it('labels a policy that differs across primaries', () => {
    render(
      <KvCacheCards
        latest={snapshot({ maxmemoryPolicy: 'mixed' })}
        history={[]}
        engines={[]}
        recentHitRate={null}
        recentBuckets={[]}
      />,
    );
    expect(cardText('TTL coverage')).toContain('Mixed maxmemory-policy across primaries');
  });
});
