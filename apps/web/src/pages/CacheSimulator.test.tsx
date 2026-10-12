import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CacheSimulatorSnapshot } from '@betterdb/shared';

const { useQuery, getSnapshot, setQueryData } = vi.hoisted(() => ({ useQuery: vi.fn(), getSnapshot: vi.fn(), setQueryData: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({ useQuery, useQueryClient: () => ({ setQueryData }) }));
vi.mock('../hooks/useConnection', () => ({ useConnection: () => ({ currentConnection: { id: 'c1' } }) }));
vi.mock('../api/cache-simulator', () => ({
  cacheSimulatorApi: { getSnapshot },
  cacheSimulatorKeys: { snapshot: (id: string | null) => ['cache-simulator', id] },
}));
vi.mock('../components/pages/cache-simulator/ProjectionChart', () => ({
  ProjectionChart: ({ projection }: { projection: { points: Array<{ bytes: number }> } }) => (
    <div data-testid="chart" data-last={Math.round(projection.points[projection.points.length - 1].bytes)} />
  ),
}));

import { CacheSimulator } from './CacheSimulator';

const ready: CacheSimulatorSnapshot = {
  status: 'ready',
  progress: null,
  instant: { usedMemory: 1_000_000, maxmemory: 2_000_000, maxmemoryPolicy: 'noeviction', totalKeys: 1000 },
  estimate: { totalBytes: 500_000, ci95Bytes: 1000, avgKeyBytes: 500, stdKeyBytes: 40, sampleCount: 400, byType: [{ type: 'string', keys: 1000, avgBytes: 500, stdBytes: 40, sampled: 400 }], sampledAt: 1, partial: false },
  growth: { keysPerDay: 25, bytesPerDay: 12_000, days: 30 },
};

const lastBytes = () => Number(screen.getByTestId('chart').getAttribute('data-last'));

describe('CacheSimulator page', () => {
  beforeEach(() => {
    useQuery.mockReset();
    getSnapshot.mockReset();
  });

  it('shows INFO figures and progress while sampling', () => {
    useQuery.mockReturnValue({ data: { ...ready, status: 'sampling', estimate: null, progress: { sampled: 1000, target: 4000 } } });
    render(<CacheSimulator />);
    expect(screen.getByText(/Sampling 1,000 of 4,000 keys/)).toBeTruthy();
  });

  it('switches the progress copy when sampling runs past the target', () => {
    useQuery.mockReturnValue({ data: { ...ready, status: 'sampling', estimate: null, progress: { sampled: 12000, target: 4000 } } });
    const { container } = render(<CacheSimulator />);
    expect(screen.getByText('Sampling 12,000 keys for a tighter range…')).toBeTruthy();
    expect(screen.queryByText(/of 4,000 keys/)).toBeNull();
    const bar = container.querySelector('.bg-primary') as HTMLElement;
    expect(bar.style.width).toBe('100%');
  });

  it('polls only while sampling', () => {
    useQuery.mockReturnValue({ data: ready });
    render(<CacheSimulator />);
    const { refetchInterval } = useQuery.mock.calls[0][0];
    expect(refetchInterval({ state: { data: { status: 'sampling' } } })).toBe(2000);
    expect(refetchInterval({ state: { data: { status: 'ready' } } })).toBe(false);
  });

  it('redraws the chart when an input changes and resets to measured', () => {
    useQuery.mockReturnValue({ data: ready });
    render(<CacheSimulator />);
    const before = lastBytes();
    fireEvent.change(screen.getByLabelText('Growth rate (keys/day)'), { target: { value: '500' } });
    expect(lastBytes()).toBeGreaterThan(before);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to measured' }));
    expect(lastBytes()).toBe(before);
  });

  it('explains the eviction consequence and recommends nodes', () => {
    useQuery.mockReturnValue({ data: ready });
    render(<CacheSimulator />);
    expect(screen.getByText(/Writes start failing with OOM errors/)).toBeTruthy();
    expect(screen.getAllByText(/cache\.|db\./).length).toBeGreaterThan(0);
  });

  it('starts growth at zero when history is missing', () => {
    useQuery.mockReturnValue({ data: { ...ready, growth: null } });
    render(<CacheSimulator />);
    expect((screen.getByLabelText('Growth rate (keys/day)') as HTMLInputElement).value).toBe('0');
    expect(screen.getByText(/Not enough history/)).toBeTruthy();
  });

  it('says no limit is set when maxmemory is 0', () => {
    useQuery.mockReturnValue({ data: { ...ready, instant: { ...ready.instant, maxmemory: 0 } } });
    render(<CacheSimulator />);
    expect(screen.getByText(/No maxmemory limit is set/)).toBeTruthy();
  });

  it('shows the failure reason and keeps manual inputs', () => {
    useQuery.mockReturnValue({ data: { ...ready, status: 'failed', estimate: null, error: "ERR unknown command 'MEMORY'" } });
    render(<CacheSimulator />);
    expect(screen.getByText(/ERR unknown command 'MEMORY'/)).toBeTruthy();
    expect(screen.getByLabelText('Average key size (bytes)')).toBeTruthy();
  });
});
