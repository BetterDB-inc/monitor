import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const { hasFeature, useQuery, updateSettings, connection, queryClient } = vi.hoisted(() => ({
  queryClient: { setQueryData: vi.fn(), invalidateQueries: vi.fn() },
  hasFeature: vi.fn(),
  useQuery: vi.fn(),
  updateSettings: vi.fn(),
  connection: { id: 'c' },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery,
  useQueryClient: () => queryClient,
}));
vi.mock('../hooks/useLicense', () => ({ useLicense: () => ({ hasFeature }) }));
vi.mock('../hooks/useConnection', () => ({ useConnection: () => ({ currentConnection: { id: connection.id } }) }));
vi.mock('../api/scaling-readiness', () => ({ scalingReadinessApi: { updateSettings } }));
vi.mock('../components/pages/scaling-readiness', () => ({
  ReadinessHeader: () => <div data-testid="header" />,
  ReadinessBreakdown: () => <div data-testid="breakdown" />,
  ReadinessHistoryChart: () => <div data-testid="history" />,
  ReadinessAlertSettings: ({
    onChange,
    saveStatus,
  }: {
    onChange: (u: { alertThreshold: number }) => void;
    saveStatus: string;
  }) => (
    <>
      <button data-testid="alert-settings" data-save-status={saveStatus} onClick={() => onChange({ alertThreshold: 55 })} />
      <button data-testid="alert-edit-2" onClick={() => onChange({ alertThreshold: 66 })} />
    </>
  ),
  ReadinessProLocked: () => <div data-testid="locked" />,
}));
vi.mock('../components/ui/date-range-picker', () => ({ DateRangePicker: ({ placeholder }: { placeholder?: string }) => (
    <span data-testid="picker">{placeholder}</span>
  ),
}));

import { ScalingReadiness } from './ScalingReadiness';

const readiness = { connectionId: 'c', computedAt: 1, score: 80, band: 'green', dimensions: [] };

describe('ScalingReadiness page', () => {
  beforeEach(() => {
    useQuery.mockReset();
    queryClient.setQueryData.mockReset();
    queryClient.invalidateQueries.mockReset();
    useQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (queryKey[0] === 'scaling-readiness') return { data: readiness, isLoading: false };
      if (queryKey[0] === 'scaling-readiness-settings')
        return { data: { connectionId: 'c', alertEnabled: true, alertThreshold: 40, updatedAt: 1 } };
      return { data: { points: [] } };
    });
  });

  it('shows the Pro lock for Community', () => {
    hasFeature.mockReturnValue(false);
    render(<ScalingReadiness />);
    expect(screen.getByTestId('locked')).toBeInTheDocument();
    expect(screen.queryByTestId('history')).not.toBeInTheDocument();
    expect(screen.queryByTestId('alert-settings')).not.toBeInTheDocument();
  });

  it('shows history and alert settings for Pro', () => {
    hasFeature.mockReturnValue(true);
    render(<ScalingReadiness />);
    expect(screen.getByTestId('history')).toBeInTheDocument();
    expect(screen.getByTestId('alert-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('locked')).not.toBeInTheDocument();
  });

  it('labels the default history range as the last 7 days', () => {
    hasFeature.mockReturnValue(true);
    render(<ScalingReadiness />);
    expect(screen.getByTestId('picker')).toHaveTextContent('Last 7 days');
  });

  it('saves a pending settings edit to its connection when the connection changes', () => {
    vi.useFakeTimers();
    updateSettings.mockReset();
    updateSettings.mockResolvedValue({});
    hasFeature.mockReturnValue(true);
    connection.id = 'c';
    const { rerender } = render(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    connection.id = 'other';
    rerender(<ScalingReadiness />);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ alertThreshold: 55 }, 'c');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    connection.id = 'c';
    vi.useRealTimers();
  });

  it('keeps a queued edit on its own connection when switching during a save', async () => {
    vi.useFakeTimers();
    updateSettings.mockReset();
    let resolveFirst: (v: unknown) => void = () => {};
    updateSettings.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    updateSettings.mockResolvedValue({});
    hasFeature.mockReturnValue(true);
    connection.id = 'c';
    const { rerender } = render(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    fireEvent.click(screen.getByTestId('alert-edit-2'));
    connection.id = 'other';
    rerender(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(updateSettings).toHaveBeenLastCalledWith({ alertThreshold: 55 }, 'other');
    await act(async () => {
      resolveFirst({});
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(updateSettings).toHaveBeenLastCalledWith({ alertThreshold: 66 }, 'c');
    expect(updateSettings).toHaveBeenCalledTimes(3);
    connection.id = 'c';
    vi.useRealTimers();
  });

  it('saves a pending settings edit when the page unmounts', () => {
    vi.useFakeTimers();
    updateSettings.mockReset();
    updateSettings.mockResolvedValue({});
    hasFeature.mockReturnValue(true);
    connection.id = 'c';
    const { unmount } = render(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    unmount();
    expect(updateSettings).toHaveBeenCalledWith({ alertThreshold: 55 }, 'c');
    vi.useRealTimers();
  });

  it('resets the save status when the connection changes', async () => {
    vi.useFakeTimers();
    updateSettings.mockReset();
    updateSettings.mockRejectedValue(new Error('boom'));
    hasFeature.mockReturnValue(true);
    connection.id = 'c';
    const { rerender } = render(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByTestId('alert-settings')).toHaveAttribute('data-save-status', 'error');
    connection.id = 'other';
    rerender(<ScalingReadiness />);
    expect(screen.getByTestId('alert-settings')).toHaveAttribute('data-save-status', 'idle');
    connection.id = 'c';
    vi.useRealTimers();
  });

  it('saves a settings edit after the debounce on the same connection', () => {
    vi.useFakeTimers();
    updateSettings.mockReset();
    updateSettings.mockResolvedValue({});
    hasFeature.mockReturnValue(true);
    render(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(updateSettings).toHaveBeenCalledWith({ alertThreshold: 55 }, 'c');
    vi.useRealTimers();
  });

  it('does not query Pro endpoints for Community', () => {
    hasFeature.mockReturnValue(false);
    render(<ScalingReadiness />);
    const proCalls = useQuery.mock.calls.filter(
      ([o]: [{ queryKey: unknown[]; enabled?: boolean }]) =>
        o.queryKey[0] !== 'scaling-readiness' && o.enabled !== false,
    );
    expect(proCalls).toHaveLength(0);
  });

  it('shows an error when readiness fails to load', () => {
    hasFeature.mockReturnValue(false);
    useQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) =>
      queryKey[0] === 'scaling-readiness'
        ? { data: undefined, isLoading: false, isError: true }
        : { data: undefined },
    );
    render(<ScalingReadiness />);
    expect(screen.getByText('Could not load scaling readiness')).toBeInTheDocument();
  });

  it('sends a queued edit after the in-flight save and caches the newer value', async () => {
    vi.useFakeTimers();
    updateSettings.mockReset();
    let resolveFirst: (v: unknown) => void = () => {};
    updateSettings.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    updateSettings.mockImplementationOnce(async (u: object) => ({ saved: u }));
    hasFeature.mockReturnValue(true);
    connection.id = 'c';
    render(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('alert-edit-2'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    queryClient.setQueryData.mockClear();
    await act(async () => {
      resolveFirst({ saved: { alertThreshold: 55 } });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenLastCalledWith({ alertThreshold: 66 }, 'c');
    const writes = queryClient.setQueryData.mock.calls.filter(([, v]: any[]) => typeof v !== 'function');
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toEqual({ saved: { alertThreshold: 66 } });
    vi.useRealTimers();
  });

  it('ignores a late completion after a connection switch', async () => {
    vi.useFakeTimers();
    updateSettings.mockReset();
    let resolveSave: (v: unknown) => void = () => {};
    updateSettings.mockImplementation(() => new Promise((r) => (resolveSave = r)));
    hasFeature.mockReturnValue(true);
    connection.id = 'c';
    const { rerender } = render(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    connection.id = 'other';
    rerender(<ScalingReadiness />);
    await act(async () => {
      resolveSave({});
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId('alert-settings')).toHaveAttribute('data-save-status', 'idle');
    connection.id = 'c';
    vi.useRealTimers();
  });

  it('shows a loading state for history', () => {
    hasFeature.mockReturnValue(true);
    useQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (queryKey[0] === 'scaling-readiness') return { data: readiness, isLoading: false };
      if (queryKey[0] === 'scaling-readiness-history') return { data: undefined, isLoading: true };
      return { data: undefined };
    });
    render(<ScalingReadiness />);
    expect(screen.getByText('Loading score history…')).toBeInTheDocument();
    expect(screen.queryByTestId('history')).not.toBeInTheDocument();
  });

  it('shows an error state for history', () => {
    hasFeature.mockReturnValue(true);
    useQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (queryKey[0] === 'scaling-readiness') return { data: readiness, isLoading: false };
      if (queryKey[0] === 'scaling-readiness-history')
        return { data: undefined, isLoading: false, isError: true };
      return { data: undefined };
    });
    render(<ScalingReadiness />);
    expect(screen.getByText('Could not load score history')).toBeInTheDocument();
    expect(screen.queryByTestId('history')).not.toBeInTheDocument();
  });
});
