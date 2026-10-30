import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MaintenanceWindowView } from '@betterdb/shared';

const { list, create, end, canMutate } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  end: vi.fn(),
  canMutate: { value: true },
}));

vi.mock('../../api/maintenance-windows', () => ({
  maintenanceWindowsApi: { list, create, end, update: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: { id: 'conn-1', name: 'primary' },
    connections: [{ id: 'conn-1', name: 'primary' }],
  }),
}));
vi.mock('../../hooks/useCanMutate', () => ({ useCanMutate: () => canMutate.value }));

import { MaintenanceWindows } from './MaintenanceWindows';

const HOUR = 60 * 60 * 1000;

function view(overrides: Partial<MaintenanceWindowView> = {}): MaintenanceWindowView {
  const now = Date.now();
  return {
    id: 'mw-1',
    name: 'Upgrade',
    reason: 'CHG-1',
    connectionId: 'conn-1',
    events: [],
    startsAt: now - HOUR,
    endsAt: now + HOUR,
    endedAt: null,
    createdBy: 'ops@example.com',
    createdAt: now - HOUR,
    updatedAt: now - HOUR,
    state: 'active',
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MaintenanceWindows />
    </QueryClientProvider>,
  );
}

describe('MaintenanceWindows', () => {
  beforeEach(() => {
    canMutate.value = true;
    list.mockReset().mockResolvedValue([]);
    create.mockReset().mockResolvedValue(view());
    end.mockReset().mockResolvedValue(view({ state: 'ended' }));
  });

  it('says alerts are flowing when nothing is scheduled', async () => {
    renderPanel();
    expect(await screen.findByText(/Alerts are being sent normally/)).toBeInTheDocument();
  });

  it('does not claim alerts are flowing when the list failed to load', async () => {
    list.mockRejectedValue(new Error('boom'));
    renderPanel();
    expect(await screen.findByText('Could not load maintenance windows.')).toBeInTheDocument();
    expect(screen.queryByText(/No maintenance scheduled/)).not.toBeInTheDocument();
  });

  it('shows an active window with its scope and lets an admin end it', async () => {
    list.mockResolvedValue([view()]);
    renderPanel();

    const banner = await screen.findByTestId('active-window');
    expect(banner).toHaveTextContent('Alerts paused: Upgrade');
    expect(banner).toHaveTextContent('primary');
    expect(banner).toHaveTextContent('All events');
    expect(banner).toHaveTextContent('CHG-1');

    fireEvent.click(screen.getByRole('button', { name: 'End now' }));
    await waitFor(() => expect(end).toHaveBeenCalledWith('mw-1'));
  });

  it('lists scheduled and recently ended windows separately', async () => {
    const now = Date.now();
    list.mockResolvedValue([
      view({ id: 's', name: 'Tonight', state: 'scheduled', startsAt: now + HOUR, endsAt: now + 2 * HOUR }),
      view({ id: 'e', name: 'Yesterday', state: 'ended', connectionId: null }),
    ]);
    renderPanel();

    expect(await screen.findByTestId('scheduled-window')).toHaveTextContent('Tonight');
    expect(screen.getByText(/Yesterday · All connections/)).toBeInTheDocument();
    expect(screen.queryByTestId('active-window')).not.toBeInTheDocument();
  });

  it('schedules a window for the current connection', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule maintenance' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Failover drill' } });
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: String(2 * HOUR) } });
    fireEvent.submit(screen.getByRole('form', { name: 'Schedule maintenance' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'Failover drill',
      connectionId: 'conn-1',
      events: [],
      reason: null,
    });
    const request = create.mock.calls[0][0];
    expect(request.endsAt - Date.now()).toBeGreaterThan(2 * HOUR - 5_000);
  });

  it('shows the validation message instead of calling the API', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule maintenance' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Schedule maintenance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the window a name.');
    expect(create).not.toHaveBeenCalled();
  });

  it('surfaces an API error', async () => {
    create.mockRejectedValue(new Error('A maintenance window can last at most 7 days'));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule maintenance' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'x' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Schedule maintenance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 7 days');
  });

  it('disables changes for read-only members', async () => {
    canMutate.value = false;
    list.mockResolvedValue([view()]);
    renderPanel();
    expect(await screen.findByRole('button', { name: 'End now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Schedule maintenance' })).toBeDisabled();
  });
});
