import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const { hasFeature, useQuery, updateSettings, connection } = vi.hoisted(() => ({
  hasFeature: vi.fn(),
  useQuery: vi.fn(),
  updateSettings: vi.fn(),
  connection: { id: 'c' },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery,
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
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
    <button data-testid="alert-settings" data-save-status={saveStatus} onClick={() => onChange({ alertThreshold: 55 })} />
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

  it('drops a pending settings edit when the connection changes', () => {
    vi.useFakeTimers();
    updateSettings.mockReset();
    updateSettings.mockResolvedValue({});
    hasFeature.mockReturnValue(true);
    connection.id = 'c';
    const { rerender } = render(<ScalingReadiness />);
    fireEvent.click(screen.getByTestId('alert-settings'));
    connection.id = 'other';
    rerender(<ScalingReadiness />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(updateSettings).not.toHaveBeenCalled();
    connection.id = 'c';
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
    expect(updateSettings).toHaveBeenCalledWith({ alertThreshold: 55 });
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
});
