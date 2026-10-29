import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockRefreshConnections = vi.fn().mockResolvedValue(undefined);
const mockSetConnection = vi.fn();

const twoConnections = [
  { id: '1', name: 'Prod', host: 'localhost', port: 6379, isConnected: true },
  { id: '2', name: 'Staging', host: 'localhost', port: 6380, isConnected: true },
];

const connectionState = vi.hoisted(() => {
  return { connections: [] as Array<Record<string, unknown>>, error: null as string | null };
});

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: null,
    connections: connectionState.connections,
    loading: false,
    error: connectionState.error,
    setConnection: mockSetConnection,
    refreshConnections: mockRefreshConnections,
    hasNoConnections: connectionState.connections.length === 0,
  }),
}));

vi.mock('../api/client', () => ({
  fetchApi: vi.fn(),
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

vi.mock('../hooks/useCanMutate', () => ({
  useCanMutate: () => true,
}));

vi.mock('../hooks/useDiscoveredInstances', () => ({
  useDiscoveredInstances: () => ({
    instances: [],
    dismiss: vi.fn(),
    invalidate: vi.fn(),
  }),
}));

import { ConnectionSelector } from './ConnectionSelector';
import { fetchApi } from '../api/client';

describe('ConnectionSelector - set as default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.connections = twoConnections;
    connectionState.error = null;
    vi.mocked(fetchApi).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('switches to the connection it makes the default', async () => {
    render(<ConnectionSelector />);

    fireEvent.click(screen.getByText('⚙', { selector: 'button' }));
    fireEvent.click(screen.getAllByTitle('Set as default')[1]);

    await waitFor(() => {
      expect(mockSetConnection).toHaveBeenCalledWith('2');
    });
    expect(fetchApi).toHaveBeenCalledWith('/connections/2/default', { method: 'POST' });
  });
});
