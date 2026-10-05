import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { hasFeature, useQuery } = vi.hoisted(() => ({ hasFeature: vi.fn(), useQuery: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({
  useQuery,
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
}));
vi.mock('../hooks/useLicense', () => ({ useLicense: () => ({ hasFeature }) }));
vi.mock('../hooks/useConnection', () => ({ useConnection: () => ({ currentConnection: { id: 'c' } }) }));
vi.mock('../components/pages/scaling-readiness', () => ({
  ReadinessHeader: () => <div data-testid="header" />,
  ReadinessBreakdown: () => <div data-testid="breakdown" />,
  ReadinessHistoryChart: () => <div data-testid="history" />,
  ReadinessAlertSettings: () => <div data-testid="alert-settings" />,
  ReadinessProLocked: () => <div data-testid="locked" />,
}));
vi.mock('../components/ui/date-range-picker', () => ({ DateRangePicker: () => null }));

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
