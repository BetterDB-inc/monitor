import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';

const findIncidentByEvent = vi.fn();
const current = { id: 'conn-1', known: ['conn-1', 'conn-2'] };

vi.mock('../api/metrics', () => ({
  metricsApi: {
    findIncidentByEvent: (anomalyId: string, at: number) => findIncidentByEvent(anomalyId, at),
  },
}));

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: { id: current.id },
    connections: current.known.map((id) => ({ id })),
    loading: false,
  }),
}));

import { IncidentByEvent } from './IncidentByEvent';
import { useConnectionUrlSync } from '../hooks/useConnectionUrlSync';
import type { Connection } from '../hooks/useConnection';

function UrlSync() {
  useConnectionUrlSync({
    connectionId: current.id,
    connections: current.known.map((id) => ({ id }) as Connection),
    loading: false,
    error: null,
    setConnection: vi.fn(),
  });
  return null;
}

function IncidentStub() {
  const { incidentId } = useParams<{ incidentId: string }>();
  const { search } = useLocation();
  return (
    <p>
      incident {incidentId} {search}
    </p>
  );
}

function renderAt(path: string, client = new QueryClient(), syncUrl = false) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/anomalies/incidents/by-event/:anomalyId" element={<IncidentByEvent />} />
          <Route path="/anomalies/incidents/:incidentId" element={<IncidentStub />} />
        </Routes>
        {syncUrl && <UrlSync />}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('IncidentByEvent', () => {
  beforeEach(() => {
    findIncidentByEvent.mockReset();
    current.id = 'conn-1';
    current.known = ['conn-1', 'conn-2'];
  });

  it('opens the incident that holds the event', async () => {
    findIncidentByEvent.mockResolvedValue({ incidentId: 'inc-1' });

    renderAt('/anomalies/incidents/by-event/ev-1?at=1000&connection=conn-1');

    expect(screen.getByRole('status')).toHaveTextContent('Finding the incident…');
    expect(await screen.findByText(/incident inc-1/)).toHaveTextContent('connection=conn-1');
    expect(findIncidentByEvent).toHaveBeenCalledWith('ev-1', 1000);
  });

  it('says so when no incident holds the event', async () => {
    findIncidentByEvent.mockResolvedValue({ incidentId: null });

    renderAt('/anomalies/incidents/by-event/ev-1?at=1000');

    expect(await screen.findByText('No incident for this event')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to anomalies' })).toHaveAttribute(
      'href',
      '/anomalies',
    );
  });

  it.each(['?at=abc', '?at=', ''])('makes no request for the link time %j', (query) => {
    renderAt(`/anomalies/incidents/by-event/ev-1${query}`);

    expect(screen.getByText('No incident for this event')).toBeInTheDocument();
    expect(findIncidentByEvent).not.toHaveBeenCalled();
  });

  it('waits until the connection named in the link is selected', () => {
    renderAt('/anomalies/incidents/by-event/ev-1?at=1000&connection=conn-2');

    expect(screen.getByRole('status')).toHaveTextContent('Finding the incident…');
    expect(findIncidentByEvent).not.toHaveBeenCalled();
  });

  it('says the connection is not available instead of looking under another one', async () => {
    current.known = ['conn-1'];

    renderAt('/anomalies/incidents/by-event/ev-1?at=1000&connection=conn-gone', undefined, true);

    expect(await screen.findByText('Connection not available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to anomalies' })).toBeInTheDocument();
    expect(screen.queryByText('No incident for this event')).not.toBeInTheDocument();
    expect(findIncidentByEvent).not.toHaveBeenCalled();
  });

  it('offers a retry when the lookup fails', async () => {
    findIncidentByEvent.mockRejectedValueOnce(new Error('boom'));
    findIncidentByEvent.mockResolvedValueOnce({ incidentId: 'inc-2' });

    renderAt('/anomalies/incidents/by-event/ev-1?at=1000');

    expect(await screen.findByText('Could not find the incident')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/incident inc-2/)).toBeInTheDocument();
  });

  it('looks the incident up again when the link is opened a second time', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
    findIncidentByEvent.mockResolvedValueOnce({ incidentId: 'inc-1' });
    findIncidentByEvent.mockResolvedValueOnce({ incidentId: 'inc-9' });
    const first = renderAt('/anomalies/incidents/by-event/ev-1?at=1000', client);
    await screen.findByText(/incident inc-1/);
    first.unmount();

    renderAt('/anomalies/incidents/by-event/ev-1?at=1000', client);

    expect(await screen.findByText(/incident inc-9/)).toBeInTheDocument();
  });
});
