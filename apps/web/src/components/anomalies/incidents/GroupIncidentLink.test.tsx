import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../../api/client';

const { lookupIncident } = vi.hoisted(() => ({ lookupIncident: vi.fn() }));

vi.mock('../../../api/metrics', () => ({ metricsApi: { lookupIncident } }));

import { GroupIncidentLink } from './GroupIncidentLink';

function renderLink() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GroupIncidentLink
          connectionId="conn-1"
          anomalies={[
            { id: 'a', timestamp: 2000 },
            { id: 'b', timestamp: 1000 },
          ]}
          linkQuery="start=1&end=2"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GroupIncidentLink', () => {
  beforeEach(() => {
    lookupIncident.mockReset();
  });

  it('looks up the incident for the group and links to it', async () => {
    lookupIncident.mockResolvedValue({ incidentId: '100-abc' });

    renderLink();

    expect(await screen.findByRole('link', { name: 'View incident timeline' })).toHaveAttribute(
      'href',
      '/anomalies/incidents/100-abc?start=1&end=2',
    );
    expect(lookupIncident).toHaveBeenCalledWith(
      { anomalyIds: ['a', 'b'], startTime: 1000, endTime: 2000 },
      expect.any(AbortSignal),
    );
  });

  it('shows no link when no incident holds the group', async () => {
    lookupIncident.mockRejectedValue(new ApiError('No incident holds these anomalies', 404));

    renderLink();

    await waitFor(() => expect(lookupIncident).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('drops the link once a refetch finds no incident', async () => {
    lookupIncident.mockResolvedValueOnce({ incidentId: '100-abc' });
    lookupIncident.mockRejectedValue(new ApiError('No incident holds these anomalies', 404));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <GroupIncidentLink
            connectionId="conn-1"
            anomalies={[{ id: 'a', timestamp: 1000 }]}
            linkQuery=""
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('link')).toBeInTheDocument();
    await act(() => client.refetchQueries());
    await waitFor(() => expect(screen.queryByRole('link')).not.toBeInTheDocument());
    expect(lookupIncident).toHaveBeenCalledTimes(2);
  });
});
