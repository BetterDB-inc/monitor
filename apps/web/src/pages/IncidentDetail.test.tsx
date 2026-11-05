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
  interval?: number;
} = { state: { data: null, error: null, loading: true, lastUpdated: null } };

vi.mock('../api/metrics', () => ({
  metricsApi: { getIncident: (id: string) => getIncident(id) },
}));

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'conn-1' } }),
}));

vi.mock('../hooks/usePolling', () => ({
  usePolling: (options: { fetcher: () => Promise<unknown>; interval?: number }) => {
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

  it('polls the incident named in the URL like the dashboard', async () => {
    renderAt('/anomalies/incidents/123-abc');

    await polling.fetcher?.();
    expect(getIncident).toHaveBeenCalledWith('123-abc');
    expect(polling.interval).toBe(5000);
    expect(screen.getByText('Loading incident…')).toBeInTheDocument();
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
