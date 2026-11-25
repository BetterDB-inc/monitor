import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PlacementMode, PlacementStatus } from '@betterdb/shared';

const { placement } = vi.hoisted(() => ({
  placement: {
    current: { status: undefined } as { status?: Partial<PlacementStatus>; error?: Error | null },
  },
}));

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: { id: 'conn-1', capabilities: { clusterEnabled: true } },
  }),
}));
vi.mock('../hooks/useLicense', () => ({
  useLicense: () => ({ hasFeature: () => false }),
}));
vi.mock('../hooks/usePlacement', () => ({
  usePlacement: () => placement.current,
}));
vi.mock('../components/anomalies/RebalanceSuggestion', () => ({
  RebalanceSuggestion: ({ mode, runnable }: { mode?: PlacementMode; runnable?: boolean }) => (
    <p>
      Suggestions in {mode ?? 'no'} mode{runnable === false ? ', not runnable' : ''}
    </p>
  ),
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
      getAnomalyEvents: vi.fn().mockResolvedValue([]),
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

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/anomalies']}>
        <AnomalyDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AnomalyDashboard placement mode', () => {
  beforeEach(() => {
    placement.current = { status: undefined, error: null };
  });

  it('holds the plans back until the placement status is read', async () => {
    renderDashboard();
    expect(await screen.findByText('Suggestions in observe mode, not runnable')).toBeInTheDocument();
  });

  it('shows the plans without a run button when the placement status cannot be read', async () => {
    placement.current = { status: undefined, error: new Error('boom') };
    renderDashboard();
    expect(await screen.findByText('Suggestions in no mode, not runnable')).toBeInTheDocument();
  });

  it('shows the suggestions in the mode the cluster runs in', async () => {
    placement.current = { status: { mode: 'recommend', effectiveMode: 'recommend' } };
    renderDashboard();
    expect(await screen.findByText('Suggestions in recommend mode')).toBeInTheDocument();
  });
});
