import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { incident } from '../components/anomalies/incidents/incident-fixtures';
import { ApiError } from '../api/client';
import type { IncidentTimeline } from '../types/anomaly';

const getIncident = vi.fn();
const polling: {
  state: {
    data: IncidentTimeline | null;
    error: Error | null;
    loading: boolean;
    lastUpdated: Date | null;
  };
  fetcher?: () => Promise<unknown>;
  interval?: number | ((data: IncidentTimeline | undefined) => number | false);
} = { state: { data: null, error: null, loading: true, lastUpdated: null } };

vi.mock('../api/metrics', () => ({
  metricsApi: { getIncident: (id: string) => getIncident(id) },
}));

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'conn-1' } }),
}));

vi.mock('../hooks/usePolling', () => ({
  usePolling: (options: {
    fetcher: () => Promise<unknown>;
    interval?: number | ((data: IncidentTimeline | undefined) => number | false);
  }) => {
    polling.fetcher = options.fetcher;
    polling.interval = options.interval;
    return polling.state;
  },
}));

import { IncidentDetail } from './IncidentDetail';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/anomalies/incidents/:incidentId" element={<IncidentDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('IncidentDetail', () => {
  beforeEach(() => {
    getIncident.mockReset();
    polling.state = { data: null, error: null, loading: true, lastUpdated: null };
  });

  it('polls the incident named in the URL', async () => {
    renderAt('/anomalies/incidents/123-abc');

    await polling.fetcher?.();
    expect(getIncident).toHaveBeenCalledWith('123-abc');
    expect(screen.getByText('Loading incident…')).toBeInTheDocument();
  });

  it('polls a recovered incident less often', () => {
    renderAt('/anomalies/incidents/123-abc');

    const interval = polling.interval as (data: IncidentTimeline | undefined) => number;
    expect(interval(undefined)).toBe(15_000);
    expect(
      interval(
        incident({
          recovery: { status: 'active', openSignals: [], unknownSignals: [], recoveredAt: null },
        }),
      ),
    ).toBe(15_000);
    expect(interval(incident())).toBe(60_000);
  });

  it('renders the incident and links back to the list', () => {
    polling.state = {
      data: incident({ matchedPatterns: ['backlog_exhaustion'] }),
      error: null,
      loading: false,
      lastUpdated: new Date(),
    };

    renderAt('/anomalies/incidents/123-abc');

    expect(screen.getByRole('heading', { name: 'Backlog Exhaustion' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to incidents/ })).toHaveAttribute(
      'href',
      '/anomalies?tab=incidents',
    );
  });

  it('keeps the date range on the back link', () => {
    polling.state = { data: incident(), error: null, loading: false, lastUpdated: new Date() };

    renderAt('/anomalies/incidents/123-abc?start=100&end=200');

    expect(screen.getByRole('link', { name: /Back to incidents/ })).toHaveAttribute(
      'href',
      '/anomalies?tab=incidents&start=100&end=200',
    );
  });

  it('keeps a loaded incident when a later poll cannot find it', () => {
    polling.state = {
      data: incident({ matchedPatterns: ['backlog_exhaustion'] }),
      error: new ApiError('Incident 123-abc not found', 404),
      loading: false,
      lastUpdated: new Date(),
    };

    renderAt('/anomalies/incidents/123-abc');

    expect(screen.getByRole('heading', { name: 'Backlog Exhaustion' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('can no longer be found');
    expect(screen.queryByText('Incident not found')).not.toBeInTheDocument();
  });

  it('warns when a refresh fails after the incident loaded', () => {
    polling.state = {
      data: incident(),
      error: new ApiError('Storage unavailable', 500),
      loading: false,
      lastUpdated: new Date(),
    };

    renderAt('/anomalies/incidents/123-abc');

    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not refresh the incident: Storage unavailable',
    );
  });

  it('keeps the connection on the back link', () => {
    polling.state = { data: incident(), error: null, loading: false, lastUpdated: new Date() };

    renderAt('/anomalies/incidents/123-abc?connection=conn-2');

    expect(screen.getByRole('link', { name: /Back to incidents/ })).toHaveAttribute(
      'href',
      '/anomalies?tab=incidents&connection=conn-2',
    );
  });

  it('says when the incident does not exist', () => {
    polling.state = {
      data: null,
      error: new ApiError('Incident 123-abc not found', 404),
      loading: false,
      lastUpdated: null,
    };

    renderAt('/anomalies/incidents/123-abc');

    expect(screen.getByText('Incident not found')).toBeInTheDocument();
  });

  it('shows other load errors', () => {
    polling.state = {
      data: null,
      error: new ApiError('Storage unavailable', 500),
      loading: false,
      lastUpdated: null,
    };

    renderAt('/anomalies/incidents/123-abc');

    expect(screen.getByText('Could not load the incident')).toBeInTheDocument();
    expect(screen.getByText('Storage unavailable')).toBeInTheDocument();
  });
});
