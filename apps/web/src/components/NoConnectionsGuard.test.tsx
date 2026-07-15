import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockRefreshConnections = vi.fn().mockResolvedValue(undefined);
const connectionState = {
  hasNoConnections: true,
  loading: false,
  error: null as string | null,
};

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: null,
    connections: [],
    loading: connectionState.loading,
    error: connectionState.error,
    setConnection: vi.fn(),
    refreshConnections: mockRefreshConnections,
    hasNoConnections: connectionState.hasNoConnections,
  }),
}));

vi.mock('../contexts/DemoContext', () => ({
  useIsDemo: () => false,
}));

const mockCapture = vi.fn();
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ client: { capture: mockCapture }, ready: true }),
}));

vi.mock('../api/client', () => ({
  fetchApi: vi.fn(),
}));

import { NoConnectionsGuard } from './NoConnectionsGuard';
import { fetchApi } from '../api/client';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NoConnectionsGuard>
        <div data-testid="page-content">content</div>
      </NoConnectionsGuard>
    </MemoryRouter>
  );
}

describe('NoConnectionsGuard - empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.hasNoConnections = true;
    connectionState.loading = false;
    connectionState.error = null;
  });

  it('renders children when connections exist', () => {
    connectionState.hasNoConnections = false;
    renderAt('/');
    expect(screen.getByTestId('page-content')).toBeInTheDocument();
  });

  it('shows the generic headline on the dashboard route', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Connect your database.');
    expect(screen.queryByTestId('page-content')).not.toBeInTheDocument();
  });

  it('shows contextual copy on feature routes', () => {
    renderAt('/slowlog');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Find your slowest queries.');
    expect(screen.getByText(/surfaces the commands slowing it down/i)).toBeInTheDocument();
  });

  it('falls back to the generic copy on unknown routes', () => {
    renderAt('/some-unknown-route');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Connect your database.');
  });

  it('shows provider guide links and the trust line', () => {
    renderAt('/');
    const upstash = screen.getByRole('link', { name: 'Upstash' });
    expect(upstash).toHaveAttribute('href', 'https://docs.betterdb.com/providers/upstash');
    expect(screen.getByRole('link', { name: 'Redis Cloud' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'AWS ElastiCache' })).toBeInTheDocument();
    expect(screen.getByText(/read-only commands like INFO, SLOWLOG/i)).toBeInTheDocument();
  });

  it('links to the connection troubleshooting guide', () => {
    renderAt('/');
    expect(
      screen.getByRole('link', { name: /connection troubleshooting guide/i })
    ).toHaveAttribute(
      'href',
      'https://docs.betterdb.com/troubleshooting.html#connection-issues'
    );
  });
});

describe('NoConnectionsGuard - quick connect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.hasNoConnections = true;
    connectionState.loading = false;
    connectionState.error = null;
  });

  it('creates a connection from a pasted URL and refreshes', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce({ id: 'conn-1' });
    renderAt('/');

    fireEvent.change(screen.getByLabelText(/quick connect/i), {
      target: { value: 'rediss://default:tok3n@my-db.upstash.io:6379' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mockRefreshConnections).toHaveBeenCalled();
    });

    expect(fetchApi).toHaveBeenCalledWith('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'my-db.upstash.io',
        host: 'my-db.upstash.io',
        port: 6379,
        username: undefined,
        password: 'tok3n',
        dbIndex: 0,
        tls: true,
        setAsDefault: true,
      }),
    });
    expect(mockCapture).toHaveBeenCalledWith(
      'quick_connect_succeeded',
      expect.objectContaining({ source: 'empty_state' })
    );
  });

  it('rejects HTTP REST URLs without calling the API', () => {
    renderAt('/');

    fireEvent.change(screen.getByLabelText(/quick connect/i), {
      target: { value: 'https://us1-example-12345.upstash.io' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(screen.getByText(/REST endpoints/i)).toBeInTheDocument();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('offers the full form prefilled when the connection fails', async () => {
    vi.mocked(fetchApi).mockRejectedValueOnce(new Error('Connection refused'));
    const eventListener = vi.fn();
    window.addEventListener('betterdb:open-add-connection', eventListener);

    renderAt('/');

    fireEvent.change(screen.getByLabelText(/quick connect/i), {
      target: { value: 'redis://user:pass@unreachable.example.com:6380' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/review details in the full form/i));

    expect(eventListener).toHaveBeenCalledTimes(1);
    const event = eventListener.mock.calls[0][0] as CustomEvent;
    expect(event.detail.prefill).toMatchObject({
      host: 'unreachable.example.com',
      port: 6380,
      username: 'user',
      password: 'pass',
      tls: false,
    });

    window.removeEventListener('betterdb:open-add-connection', eventListener);
  });

  it('connects to localhost via the Docker quick start', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce({ id: 'conn-local' });
    renderAt('/');

    fireEvent.click(screen.getByRole('button', { name: /connect localhost:6379/i }));

    await waitFor(() => {
      expect(mockRefreshConnections).toHaveBeenCalled();
    });

    expect(fetchApi).toHaveBeenCalledWith('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Local Valkey',
        host: 'localhost',
        port: 6379,
        dbIndex: 0,
        tls: false,
        setAsDefault: true,
      }),
    });
  });
});
