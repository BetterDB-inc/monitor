import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

import { ConnectionSelector } from './ConnectionSelector';

describe('ConnectionSelector - single connection row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks a lone OTLP-pushed connection the same way the switcher does', () => {
    connectionState.connections = [
      {
        id: '1',
        name: 'Pushed',
        host: 'cache.internal',
        port: 6380,
        isConnected: true,
        connectionType: 'external',
      },
    ];

    render(<ConnectionSelector />);

    expect(screen.getByText('Pushed')).toBeInTheDocument();
    expect(screen.getByText('OTLP')).toBeInTheDocument();
  });

  it('does not show the OTLP badge for a lone direct connection', () => {
    connectionState.connections = [
      { id: '1', name: 'Prod', host: 'localhost', port: 6379, isConnected: true },
    ];

    render(<ConnectionSelector />);

    expect(screen.getByText('Prod')).toBeInTheDocument();
    expect(screen.queryByText('OTLP')).toBeNull();
  });
});
