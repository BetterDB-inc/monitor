import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IncidentList } from './IncidentList';
import { entry, incident, T0 } from './incident-fixtures';

function renderList(
  incidents: Parameters<typeof IncidentList>[0]['incidents'],
  now = T0 + 600_000,
) {
  return render(
    <MemoryRouter>
      <IncidentList incidents={incidents} now={now} />
    </MemoryRouter>,
  );
}

describe('IncidentList', () => {
  it('shows an empty state without incidents', () => {
    renderList([]);
    expect(screen.getByText('No incidents in this time range')).toBeInTheDocument();
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
});
