import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CacheSimulatorSnapshot } from '@betterdb/shared';

const { useQuery, getSnapshot, setQueryData, cancelQueries, connection } = vi.hoisted(() => ({ useQuery: vi.fn(), getSnapshot: vi.fn(), setQueryData: vi.fn(), cancelQueries: vi.fn(), connection: { id: 'c1' } }));

vi.mock('@tanstack/react-query', () => ({ useQuery, useQueryClient: () => ({ setQueryData, cancelQueries }) }));
vi.mock('../hooks/useConnection', () => ({ useConnection: () => ({ currentConnection: connection }) }));
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
    setQueryData.mockReset();
    cancelQueries.mockReset();
    cancelQueries.mockResolvedValue(undefined);
    connection.id = 'c1';
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

  it('keeps unedited inputs following the measurement after an edit during sampling', () => {
    useQuery.mockReturnValue({ data: { ...ready, status: 'sampling', estimate: null, progress: { sampled: 100, target: 4000 } } });
    const { rerender } = render(<CacheSimulator />);
    fireEvent.change(screen.getByLabelText('Growth rate (keys/day)'), { target: { value: '500' } });
    useQuery.mockReturnValue({ data: ready });
    rerender(<CacheSimulator />);
    expect((screen.getByLabelText('Average key size (bytes)') as HTMLInputElement).value).toBe('500');
    expect((screen.getByLabelText('Per-key overhead (bytes)') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('Growth rate (keys/day)') as HTMLInputElement).value).toBe('500');
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

  it('shows only the error and refresh when setup fails', () => {
    const zeroed = { usedMemory: 0, maxmemory: 0, maxmemoryPolicy: 'unknown', totalKeys: 0 };
    useQuery.mockReturnValue({ data: { ...ready, status: 'failed', estimate: null, growth: null, instant: zeroed, error: 'connection refused' } });
    render(<CacheSimulator />);
    expect(screen.getByText('Could not read this instance: connection refused')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh sample' })).toBeTruthy();
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.queryByLabelText('Average key size (bytes)')).toBeNull();
    expect(screen.queryByText(/The projection below uses INFO figures/)).toBeNull();
  });

  it('shows an inline error when refresh rejects', async () => {
    useQuery.mockReturnValue({ data: ready });
    getSnapshot.mockRejectedValue(new Error('boom'));
    render(<CacheSimulator />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sample' }));
    await waitFor(() => expect(screen.getByText(/Could not refresh the sample: boom/)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Refresh sample' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables refresh while pending and sends one request', async () => {
    useQuery.mockReturnValue({ data: ready });
    let resolve: (value: CacheSimulatorSnapshot) => void = () => {};
    getSnapshot.mockReturnValue(new Promise<CacheSimulatorSnapshot>((r) => (resolve = r)));
    render(<CacheSimulator />);
    const button = screen.getByRole('button', { name: 'Refresh sample' }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: ['cache-simulator', 'c1'] });
    await act(async () => resolve(ready));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(setQueryData).toHaveBeenCalledWith(['cache-simulator', 'c1'], ready);
  });

  it('keeps edits when sampling finishes', () => {
    useQuery.mockReturnValue({ data: { ...ready, status: 'sampling', estimate: null, progress: { sampled: 10, target: 4000 } } });
    const { rerender } = render(<CacheSimulator />);
    fireEvent.change(screen.getByLabelText('Growth rate (keys/day)'), { target: { value: '500' } });
    useQuery.mockReturnValue({ data: ready });
    rerender(<CacheSimulator />);
    expect((screen.getByLabelText('Growth rate (keys/day)') as HTMLInputElement).value).toBe('500');
  });

  it('lets a numeric field be cleared and retyped', () => {
    useQuery.mockReturnValue({ data: ready });
    render(<CacheSimulator />);
    const input = screen.getByLabelText('Average key size (bytes)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '700' } });
    expect(input.value).toBe('700');
  });

  it('ignores negative and non-finite values', () => {
    useQuery.mockReturnValue({ data: ready });
    render(<CacheSimulator />);
    const before = lastBytes();
    fireEvent.change(screen.getByLabelText('Average key size (bytes)'), { target: { value: '-5' } });
    fireEvent.change(screen.getByLabelText('Per-key overhead (bytes)'), { target: { value: '1e999' } });
    expect(lastBytes()).toBe(before);
  });

  it('says memory stays flat when no limit is set and nothing grows', () => {
    useQuery.mockReturnValue({ data: { ...ready, growth: null, instant: { ...ready.instant, maxmemory: 0 } } });
    render(<CacheSimulator />);
    expect(screen.getByText('No maxmemory limit is set. Memory stays flat over the next 30 days.')).toBeTruthy();
  });

  it('says memory shrinks when no limit is set and the projection declines', () => {
    useQuery.mockReturnValue({ data: { ...ready, instant: { ...ready.instant, maxmemory: 0 } } });
    render(<CacheSimulator />);
    fireEvent.change(screen.getByLabelText('Growth rate (keys/day)'), { target: { value: '-10' } });
    expect(screen.getByText('No maxmemory limit is set. Memory shrinks over the next 30 days.')).toBeTruthy();
  });

  it('says when no catalog node fits the projection', () => {
    useQuery.mockReturnValue({ data: ready });
    render(<CacheSimulator />);
    fireEvent.change(screen.getByLabelText('Average key size (bytes)'), { target: { value: '1000000000000' } });
    expect(screen.getByText(/No AWS node in the catalog fits this projection/)).toBeTruthy();
  });

  it('offers a retry when the first load fails', () => {
    const refetch = vi.fn();
    useQuery.mockReturnValue({ data: undefined, isError: true, error: new Error('timeout'), refetch });
    render(<CacheSimulator />);
    expect(screen.getByText('Could not load the cache size simulator: timeout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a refetch error beside the last result', () => {
    useQuery.mockReturnValue({ data: ready, isError: true, error: new Error('timeout') });
    render(<CacheSimulator />);
    expect(screen.getByText('Could not update the snapshot, showing the last result: timeout')).toBeTruthy();
    expect(screen.getByTestId('chart')).toBeTruthy();
  });

  it('explains a mixed cluster eviction policy', () => {
    useQuery.mockReturnValue({ data: { ...ready, instant: { ...ready.instant, maxmemoryPolicy: 'mixed' } } });
    render(<CacheSimulator />);
    expect(screen.getByText(/primaries use different eviction policies/)).toBeTruthy();
  });

  it('drops edits when the connection changes', () => {
    useQuery.mockReturnValue({ data: ready });
    const { rerender } = render(<CacheSimulator />);
    fireEvent.change(screen.getByLabelText('Growth rate (keys/day)'), { target: { value: '500' } });
    connection.id = 'c2';
    rerender(<CacheSimulator />);
    connection.id = 'c1';
    rerender(<CacheSimulator />);
    expect((screen.getByLabelText('Growth rate (keys/day)') as HTMLInputElement).value).toBe('25');
  });

  it('keeps edits for another connection when a refresh finishes', async () => {
    useQuery.mockReturnValue({ data: ready });
    let resolve: (value: CacheSimulatorSnapshot) => void = () => {};
    getSnapshot.mockReturnValue(new Promise<CacheSimulatorSnapshot>((r) => (resolve = r)));
    const { rerender } = render(<CacheSimulator />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sample' }));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1));
    connection.id = 'c2';
    rerender(<CacheSimulator />);
    fireEvent.change(screen.getByLabelText('Growth rate (keys/day)'), { target: { value: '500' } });
    await act(async () => resolve(ready));
    expect((screen.getByLabelText('Growth rate (keys/day)') as HTMLInputElement).value).toBe('500');
  });

  it('says memory levels off when a TTL caps growth and no limit is set', () => {
    useQuery.mockReturnValue({ data: { ...ready, instant: { ...ready.instant, maxmemory: 0 } } });
    render(<CacheSimulator />);
    fireEvent.change(screen.getByLabelText('Key TTL (days)'), { target: { value: '60' } });
    expect(screen.getByText(/Memory grows, then levels off near .* as keys expire\./)).toBeTruthy();
    expect(screen.queryByText(/until the host runs out/)).toBeNull();
  });

  it('clears a refresh error and pending state when the connection changes', async () => {
    useQuery.mockReturnValue({ data: ready });
    getSnapshot.mockRejectedValueOnce(new Error('boom')).mockReturnValueOnce(new Promise(() => undefined));
    const { rerender } = render(<CacheSimulator />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sample' }));
    await waitFor(() => expect(screen.getByText(/Could not refresh the sample: boom/)).toBeTruthy());
    connection.id = 'c2';
    rerender(<CacheSimulator />);
    expect(screen.queryByText(/Could not refresh the sample/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sample' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh sample' }) as HTMLButtonElement).disabled).toBe(true));
    connection.id = 'c1';
    rerender(<CacheSimulator />);
    expect((screen.getByRole('button', { name: 'Refresh sample' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
