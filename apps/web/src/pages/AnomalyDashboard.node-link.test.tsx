import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const EVENT = vi.hoisted(() => ({
  id: 'evt-1',
  timestamp: Date.now() - 60_000,
  metricType: 'replication_lag',
  anomalyType: 'spike',
  severity: 'warning',
  value: 9,
  baseline: 1,
  stdDev: 1,
  zScore: 3,
  threshold: 2,
  message: 'Replica 10.0.0.2:6379 is falling behind',
  resolved: false,
  connectionId: 'conn-1',
  node: {
    nodeId: 'n2',
    address: '10.0.0.2:6379',
    role: 'replica',
    shardId: 'f'.repeat(40),
    collected: false,
  },
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
        totalEvents: 1,
        totalGroups: 1,
        bySeverity: {},
        byMetric: {},
        byPattern: {},
        activeEvents: 1,
        resolvedEvents: 0,
      }),
      getAnomalyEvents: vi.fn().mockResolvedValue([EVENT]),
      getAnomalyCoverage: vi.fn().mockResolvedValue([]),
      getHotShards: vi.fn().mockResolvedValue([]),
      getAnomalyGroups: vi.fn().mockResolvedValue([]),
      getIncidents: vi.fn().mockResolvedValue([]),
      getReplicationDivergence: vi.fn().mockResolvedValue([]),
      getAnomalyBuffers: vi.fn().mockResolvedValue([]),
    },
  };
});

import { AnomalyDashboard } from './AnomalyDashboard';

describe('AnomalyDashboard node link', () => {
  it('links a recent event to the node it is on and says the node is not collected', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/anomalies']}>
          <AnomalyDashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('link', { name: '10.0.0.2:6379' })).toHaveAttribute(
      'href',
      '/cluster?tab=nodes&node=n2&connection=conn-1',
    );
    expect(screen.getByText('replica · shard ffffffff')).toBeInTheDocument();
    expect(screen.getByText('Not collected')).toBeInTheDocument();
  });
});
