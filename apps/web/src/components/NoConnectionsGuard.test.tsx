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

const DEFAULT_CONNECT_DEFAULTS = { host: 'localhost', source: 'local', containerized: false };

/**
 * Route the mocked fetchApi by path. DockerQuickStart probes
 * `/system/connect-defaults` on mount, so every render needs that to resolve;
 * tests override the `/connections` POST result via `onConnections`.
 */
function installFetch(
  opts: {
    connectDefaults?: { host: string; source?: string; containerized?: boolean; port?: number };
    onConnections?: () => Promise<unknown>;
  } = {},
) {
  vi.mocked(fetchApi).mockImplementation((path: string) => {
    if (path === '/system/connect-defaults') {
      return Promise.resolve(opts.connectDefaults ?? DEFAULT_CONNECT_DEFAULTS);
    }
    if (path === '/connections' && opts.onConnections) {
      return opts.onConnections();
    }
    return Promise.resolve(undefined);
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NoConnectionsGuard>
        <div data-testid="page-content">content</div>
      </NoConnectionsGuard>
    </MemoryRouter>,
  );
}

describe('NoConnectionsGuard - empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.hasNoConnections = true;
    connectionState.loading = false;
    connectionState.error = null;
    installFetch();
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
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Find your slowest queries.',
    );
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
    expect(screen.getByRole('link', { name: /connection troubleshooting guide/i })).toHaveAttribute(
      'href',
      'https://docs.betterdb.com/troubleshooting.html#connection-issues',
    );
  });
});

describe('NoConnectionsGuard - quick connect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.hasNoConnections = true;
    connectionState.loading = false;
    connectionState.error = null;
    installFetch();
  });

  it('creates a connection from a pasted URL and refreshes', async () => {
    installFetch({ onConnections: () => Promise.resolve({ id: 'conn-1' }) });
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
      expect.objectContaining({ source: 'empty_state' }),
    );
  });

  it('rejects HTTP REST URLs without calling the API', () => {
    renderAt('/');

    fireEvent.change(screen.getByLabelText(/quick connect/i), {
      target: { value: 'https://us1-example-12345.upstash.io' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(screen.getByText(/REST endpoints/i)).toBeInTheDocument();
    // The mount-time connect-defaults probe may run, but no connection is created.
    expect(fetchApi).not.toHaveBeenCalledWith('/connections', expect.anything());
  });

  it('offers the full form prefilled when the connection fails', async () => {
    installFetch({ onConnections: () => Promise.reject(new Error('Connection refused')) });
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

  it('connects to the resolved local host via the Docker quick start', async () => {
    installFetch({
      connectDefaults: { host: '127.0.0.1', source: 'local', containerized: false },
      onConnections: () => Promise.resolve({ id: 'conn-local' }),
    });
    renderAt('/');

    // The button label reflects the host the API resolved.
    fireEvent.click(await screen.findByRole('button', { name: /connect 127\.0\.0\.1:6379/i }));

    await waitFor(() => {
      expect(mockRefreshConnections).toHaveBeenCalled();
    });

    expect(fetchApi).toHaveBeenCalledWith('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Local Valkey',
        host: '127.0.0.1',
        port: 6379,
        dbIndex: 0,
        tls: false,
        setAsDefault: true,
      }),
    });
  });

  it('targets host.docker.internal when the monitor is itself containerized', async () => {
    installFetch({
      connectDefaults: { host: 'host.docker.internal', source: 'docker', containerized: true },
      onConnections: () => Promise.resolve({ id: 'conn-docker' }),
    });
    renderAt('/');

    fireEvent.click(
      await screen.findByRole('button', { name: /connect host\.docker\.internal:6379/i }),
    );

    await waitFor(() => {
      expect(mockRefreshConnections).toHaveBeenCalled();
    });

    expect(fetchApi).toHaveBeenCalledWith('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Local Valkey',
        host: 'host.docker.internal',
        port: 6379,
        dbIndex: 0,
        tls: false,
        setAsDefault: true,
      }),
    });
  });

  it('honors the DB_PORT the endpoint returns for the local connection', async () => {
    installFetch({
      connectDefaults: { host: 'db.internal', source: 'docker', containerized: true, port: 6380 },
      onConnections: () => Promise.resolve({ id: 'conn-env' }),
    });
    renderAt('/');

    // Label and POST body both carry the resolved port, not a hardcoded 6379.
    fireEvent.click(await screen.findByRole('button', { name: /connect db\.internal:6380/i }));

    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Local Valkey',
          host: 'db.internal',
          port: 6380,
          dbIndex: 0,
          tls: false,
          setAsDefault: true,
        }),
      });
    });
  });

  it('hides the one-click connect for an env-configured host and points to the manual form', async () => {
    installFetch({
      connectDefaults: {
        host: 'valkey.prod.corp.internal',
        source: 'env',
        containerized: true,
        port: 6379,
      },
      onConnections: () => Promise.resolve({ id: 'conn-env' }),
    });
    renderAt('/');

    // The env host's credentials and TLS live server-side and can't be carried
    // client-side, so a one-click connect would strip them and fail. We offer
    // the manual form instead and never render the internal hostname as a
    // connect target (nor leak it to telemetry, since no POST is made).
    await screen.findByText(/configured from your environment/i);
    expect(screen.queryByRole('button', { name: /connect \S+:\d+/i })).toBeNull();
    expect(screen.queryByText('valkey.prod.corp.internal')).toBeNull();
    expect(fetchApi).not.toHaveBeenCalledWith('/connections', expect.anything());
  });

  it('gates the button until the probe settles, then falls back to localhost', async () => {
    let rejectProbe: (err: Error) => void = () => {};
    vi.mocked(fetchApi).mockImplementation((path: string) => {
      if (path === '/system/connect-defaults') {
        return new Promise((_, reject) => {
          rejectProbe = reject;
        });
      }
      return Promise.resolve({ id: 'conn-local' });
    });
    renderAt('/');

    // While the probe is in flight the button is disabled — a click must not
    // POST the placeholder `localhost` as the default connection.
    const preparing = await screen.findByRole('button', { name: /preparing/i });
    expect(preparing).toBeDisabled();
    fireEvent.click(preparing);
    expect(fetchApi).not.toHaveBeenCalledWith('/connections', expect.anything());

    // Probe rejects → fall back to localhost and enable the button.
    rejectProbe(new Error('offline'));

    fireEvent.click(await screen.findByRole('button', { name: /connect localhost:6379/i }));
    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith(
        '/connections',
        expect.objectContaining({ body: expect.stringContaining('"host":"localhost"') }),
      );
    });
  });
});
