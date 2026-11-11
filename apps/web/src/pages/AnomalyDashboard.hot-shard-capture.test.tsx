import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { HotShardDetail } from '../types/anomaly';

const { getAnomalyEvents, getHotShards } = vi.hoisted(() => ({
  getAnomalyEvents: vi.fn(),
  getHotShards: vi.fn(),
}));

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'conn-1' } }),
}));
vi.mock('../hooks/useLicense', () => ({
  useLicense: () => ({ hasFeature: () => false }),
}));
vi.mock('../api/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/metrics')>();
  return {
    ...actual,
    metricsApi: {
      getAnomalySummary: vi.fn().mockResolvedValue({
        totalEvents: 0,
        totalGroups: 0,
        bySeverity: {},
        byMetric: {},
        byPattern: {},
        activeEvents: 0,
        resolvedEvents: 0,
      }),
      getAnomalyEvents,
      getAnomalyCoverage: vi.fn().mockResolvedValue([]),
      getHotShards,
      getAnomalyGroups: vi.fn().mockResolvedValue([]),
      getIncidents: vi.fn().mockResolvedValue([]),
      getReplicationDivergence: vi.fn().mockResolvedValue([]),
      getAnomalyBuffers: vi.fn().mockResolvedValue([]),
    },
  };
});

import { AnomalyDashboard } from './AnomalyDashboard';

const ACTION = 'Capture on hot primary';
const NOW = Date.now();
const HOUR_MS = 3_600_000;
const HOT_EVENT = {
  id: 'evt-hot',
  timestamp: NOW - 72 * HOUR_MS,
  metricType: 'hot_shard',
  anomalyType: 'spike',
  severity: 'warning',
  value: 9,
  baseline: 1,
  zScore: 0,
  message: 'Hot shard a0000000 at 10.0.0.1:6379: CPU 9.0x the cluster median.',
  resolved: false,
};
const HOT_SHARD: HotShardDetail = {
  eventId: 'evt-hot',
  captureAvailable: true,
  shardId: 'a0000000',
  nodeAddr: '10.0.0.1:6379',
  slotCount: 2,
  since: NOW - 72 * HOUR_MS,
  sampledAt: NOW,
  cpu: { perSecond: 900_000, share: 0.82, median: 100_000, ratio: 9 },
  network: { perSecond: 0, share: 0, median: 0 },
  topSlots: [],
  topKeys: [],
  keySource: 'unavailable',
  keyNote: 'maxmemory-policy is not an LFU policy, so the node keeps no access frequency',
  keysSampled: 0,
};

type EventQuery = { metricType?: string; activeOnly?: boolean } | undefined;

function listed(inRange: unknown[]) {
  getAnomalyEvents.mockImplementation(async (query: EventQuery) => {
    if (!query?.activeOnly) return inRange;
    return query.metricType === 'hot_shard' ? [HOT_EVENT] : [];
  });
}

function renderDashboard(search = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/anomalies${search}`]}>
        <AnomalyDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AnomalyDashboard hot shard capture', () => {
  beforeEach(() => {
    getAnomalyEvents.mockReset();
    getHotShards.mockReset().mockResolvedValue([HOT_SHARD]);
  });

  it('offers the capture for an open hot shard that is older than the selected range', async () => {
    listed([]);

    renderDashboard(`?start=${NOW - HOUR_MS}&end=${NOW}`);

    expect(await screen.findByRole('button', { name: ACTION })).toBeInTheDocument();
    expect(getAnomalyEvents).toHaveBeenCalledWith({ metricType: 'hot_shard', activeOnly: true });
  });

  it('offers the capture when the event is past the 50 rows of the event list', async () => {
    const newer = Array.from({ length: 60 }, (_, n) => ({
      ...HOT_EVENT,
      id: `evt-${n}`,
      timestamp: NOW - n * 1_000,
      metricType: 'memory_used',
      message: `memory spike ${n}`,
    }));
    listed([...newer, HOT_EVENT]);

    renderDashboard();

    expect(await screen.findByText('memory spike 0')).toBeInTheDocument();
    expect(screen.queryByText('memory spike 50')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: ACTION })).toBeInTheDocument();
  });

  it('does not read the hot shard list while no hot shard is open', async () => {
    getAnomalyEvents.mockResolvedValue([]);

    renderDashboard();

    await waitFor(() =>
      expect(getAnomalyEvents).toHaveBeenCalledWith({ metricType: 'hot_shard', activeOnly: true }),
    );
    expect(getHotShards).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });
});
