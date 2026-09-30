import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockRefreshConnections = vi.fn().mockResolvedValue(undefined);
const mockSetConnection = vi.fn();

const connectionState = vi.hoisted(() => {
  return { connections: [] as Array<Record<string, unknown>> };
});

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: connectionState.connections[0] ?? null,
    connections: connectionState.connections,
    loading: false,
    error: null,
    setConnection: mockSetConnection,
    refreshConnections: mockRefreshConnections,
    hasNoConnections: connectionState.connections.length === 0,
  }),
}));

vi.mock('../api/client', () => ({
  fetchApi: vi.fn(),
  apiOrigin: () => 'http://localhost:3001',
  setCurrentConnectionId: vi.fn(),
}));

vi.mock('../api/databases', () => ({
  databasesApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    credentials: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../api/workspace', () => ({
  workspaceApi: {
    getMe: vi.fn().mockResolvedValue({ role: 'owner' }),
  },
}));

vi.mock('./ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>Select</span>,
}));

vi.mock('./ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const mutateState = vi.hoisted(() => ({ canMutate: true }));

vi.mock('../hooks/useCanMutate', () => ({
  useCanMutate: () => mutateState.canMutate,
}));

const discoveredState = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  dismiss: vi.fn().mockResolvedValue(undefined),
  invalidate: vi.fn().mockResolvedValue(undefined),
}));

const mockUseDiscoveredInstances = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useDiscoveredInstances', () => ({
  useDiscoveredInstances: mockUseDiscoveredInstances,
}));

import { ConnectionSelector } from './ConnectionSelector';
import { fetchApi } from '../api/client';

const instance = {
  host: 'cache.internal',
  port: 6380,
  suggestedName: 'orders-cache',
  firstSeenAt: 0,
  lastSeenAt: Date.now(),
  droppedPoints: 4,
};

const single = {
  id: 'one',
  name: 'Only',
  host: 'only.local',
  port: 6379,
  isConnected: true,
  connectionType: 'direct',
  capabilities: { dbType: 'valkey', version: '8.0.0' },
};

describe('ConnectionSelector - discovered instances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.connections = [single];
    discoveredState.instances = [instance];
    mutateState.canMutate = true;
    mockUseDiscoveredInstances.mockImplementation((enabled: boolean) =>
      enabled ? discoveredState : { ...discoveredState, instances: [] },
    );
  });

  it('shows the section below a single connection', () => {
    render(<ConnectionSelector />);
    expect(screen.getByRole('button', { name: /1 discovered via OTLP/ })).toBeInTheDocument();
  });

  it('hides the section when nothing was discovered', () => {
    discoveredState.instances = [];
    render(<ConnectionSelector />);
    expect(screen.queryByRole('button', { name: /discovered via OTLP/ })).toBeNull();
  });

  it('register opens the OTLP tab prefilled and saves an external connection', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ id: 'new-id' });
    render(<ConnectionSelector />);
    fireEvent.click(screen.getByRole('button', { name: /discovered via OTLP/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Register orders-cache' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('orders-cache')).toBeInTheDocument();
    expect(screen.getByDisplayValue('cache.internal')).toBeInTheDocument();
    expect(screen.getByDisplayValue('6380')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add otlp connection/i }));
    await waitFor(() => expect(discoveredState.invalidate).toHaveBeenCalled());
    expect(mockRefreshConnections).toHaveBeenCalled();
    const body = JSON.parse(
      (vi.mocked(fetchApi).mock.calls.find(([u]) => u === '/connections')![1] as RequestInit)
        .body as string,
    );
    expect(body).toMatchObject({
      name: 'orders-cache',
      host: 'cache.internal',
      port: 6380,
      connectionType: 'external',
    });
  });

  it('dismiss calls the hook', () => {
    render(<ConnectionSelector />);
    fireEvent.click(screen.getByRole('button', { name: /discovered via OTLP/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss orders-cache' }));
    expect(discoveredState.dismiss).toHaveBeenCalledWith(instance);
  });

  it('opens the OTLP tab blank after a prefilled dialog is closed by another route', () => {
    render(<ConnectionSelector />);
    fireEvent.click(screen.getByRole('button', { name: /discovered via OTLP/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Register orders-cache' }));
    expect(screen.getByDisplayValue('cache.internal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Direct Connection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTitle('Add connection'));
    fireEvent.click(screen.getByRole('button', { name: 'OTLP push' }));
    expect(screen.queryByDisplayValue('orders-cache')).toBeNull();
    expect(screen.queryByDisplayValue('cache.internal')).toBeNull();
  });

  it('swallows a failed dismiss', async () => {
    const failure = Promise.reject(new Error('boom'));
    const caught = vi.fn();
    const originalCatch = failure.catch.bind(failure);
    failure.catch = ((handler: (reason: unknown) => unknown) => {
      caught();
      return originalCatch(handler);
    }) as typeof failure.catch;
    discoveredState.dismiss.mockReturnValueOnce(failure);
    render(<ConnectionSelector />);
    fireEvent.click(screen.getByRole('button', { name: /discovered via OTLP/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss orders-cache' }));
    expect(caught).toHaveBeenCalled();
  });

  it('does not offer discovery when the user cannot mutate', () => {
    mutateState.canMutate = false;
    render(<ConnectionSelector />);
    expect(mockUseDiscoveredInstances).toHaveBeenCalledWith(false);
    expect(mockUseDiscoveredInstances).not.toHaveBeenCalledWith(true);
    expect(screen.queryByRole('button', { name: /Register/ })).toBeNull();
  });
});
