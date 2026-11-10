import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IncidentList } from './IncidentList';
import { entry, incident, T0 } from './incident-fixtures';

function renderList(
  incidents: Parameters<typeof IncidentList>[0]['incidents'],
  props: Partial<Parameters<typeof IncidentList>[0]> = {},
) {
  return render(
    <MemoryRouter>
      <IncidentList incidents={incidents} now={T0 + 600_000} {...props} />
    </MemoryRouter>,
  );
}

describe('IncidentList', () => {
  it('shows an empty state without incidents', () => {
    renderList([]);
    expect(screen.getByText('No incidents in this time range')).toBeInTheDocument();
  });

  it('shows loading instead of the empty state before the first response', () => {
    renderList(undefined, { loading: true });
    expect(screen.getByRole('status')).toHaveTextContent('Loading incidents…');
    expect(screen.queryByText('No incidents in this time range')).not.toBeInTheDocument();
  });

  it('shows a loading state over the previous incidents while a new range loads', () => {
    renderList([incident({ incidentId: 'a' })], { refreshing: true });
    expect(screen.getByRole('status')).toHaveTextContent('Loading incidents…');
    expect(screen.getByTestId('incident-rows')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('shows loading instead of a previous empty range while a new range loads', () => {
    renderList([], { refreshing: true });
    expect(screen.getByRole('status')).toHaveTextContent('Loading incidents…');
    expect(screen.queryByText('No incidents in this time range')).not.toBeInTheDocument();
  });

  it('shows no loading state once the incidents belong to the selected range', () => {
    renderList([incident({ incidentId: 'a' })]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTestId('incident-rows')).toHaveAttribute('aria-busy', 'false');
  });

  it('says when more incidents came back than the limit and keeps the date range on links', () => {
    renderList(
      [incident({ incidentId: 'a' }), incident({ incidentId: 'b' }), incident({ incidentId: 'c' })],
      { limit: 2, linkQuery: 'start=1&end=2' },
    );
    expect(
      screen.getByText('Showing the newest 2 incidents. Narrow the time range to see older ones.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getAllByRole('link')[0]).toHaveAttribute(
      'href',
      '/anomalies/incidents/a?start=1&end=2',
    );
  });

  it('shows no cap notice when exactly the limit came back', () => {
    renderList([incident({ incidentId: 'a' }), incident({ incidentId: 'b' })], { limit: 2 });
    expect(screen.queryByText(/Showing the newest/)).not.toBeInTheDocument();
  });

  it('lists pattern, scope, duration and status, linking to the detail view', () => {
    renderList([
      incident({
        matchedPatterns: ['retry_storm'],
        connectionIds: ['conn-1', 'conn-2'],
        entries: [
          entry({ anomalyId: 'a', nodeAddr: '10.0.0.1:6379' }),
          entry({ anomalyId: 'b', nodeAddr: '10.0.0.2:6379' }),
        ],
      }),
    ]);

    const link = screen.getByRole('link', { name: 'Retry Storm' });
    expect(link).toHaveAttribute('href', `/anomalies/incidents/${T0}-0123456789abcdef`);
    expect(screen.getByText('2 connections · 2 nodes')).toBeInTheDocument();
    expect(screen.getByText('2m 0s')).toBeInTheDocument();
    expect(screen.getByText('Recovered')).toBeInTheDocument();
  });

  it('names an incident without a pattern after its first signal and marks open ones as ongoing', () => {
    renderList([
      incident({
        recovery: {
          status: 'degraded',
          openSignals: ['connections'],
          unknownSignals: [],
          recoveredAt: null,
        },
      }),
    ]);

    expect(screen.getByRole('link', { name: 'Connections' })).toBeInTheDocument();
    expect(screen.getByText('10m 0s so far')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('marks an incident without a connection as unscoped', () => {
    renderList([incident({ connectionIds: [] })]);

    expect(screen.getByText('Unscoped')).toBeInTheDocument();
  });

  it('ticks the duration of an open incident without a fixed clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 60_000);
    try {
      renderList(
        [
          incident({
            recovery: { status: 'active', openSignals: [], unknownSignals: [], recoveredAt: null },
          }),
        ],
        { now: undefined },
      );
      expect(screen.getByText('1m 0s so far')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(2_000);
      });

      expect(screen.getByText('1m 2s so far')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs one clock for every open incident', () => {
    vi.useFakeTimers();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      const open = {
        status: 'active' as const,
        openSignals: [],
        unknownSignals: [],
        recoveredAt: null,
      };
      renderList(
        [
          incident({ incidentId: 'a', recovery: open }),
          incident({ incidentId: 'b', recovery: open }),
          incident({ incidentId: 'c', recovery: open }),
        ],
        { now: undefined },
      );

      expect(intervals).toHaveBeenCalledTimes(1);
    } finally {
      intervals.mockRestore();
      vi.useRealTimers();
    }
  });
});
