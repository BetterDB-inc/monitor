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

  it('shows an empty TTL coverage when no keys were sampled', () => {
    render(
      <KvCacheCards
        latest={snapshot({ sampledKeys: 0, noTtlRatio: 0 })}
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
});
