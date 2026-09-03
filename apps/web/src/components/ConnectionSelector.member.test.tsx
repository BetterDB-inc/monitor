import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

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
    getMe: vi.fn().mockResolvedValue({ role: 'member' }),
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
  useCanMutate: () => false,
}));

import { ConnectionSelector } from './ConnectionSelector';

describe('ConnectionSelector - read-only member', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.connections = twoConnections;
    connectionState.error = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables the Add and Manage connection buttons', () => {
    render(<ConnectionSelector />);

    const addButton = screen.getByText('+', { selector: 'button' });
    const manageButton = screen.getByText('⚙', { selector: 'button' });

    expect(addButton).toBeDisabled();
    expect(manageButton).toBeDisabled();
  });

  it('shows a placeholder instead of the first-connection call to action', () => {
    connectionState.connections = [];
    render(<ConnectionSelector />);

    expect(screen.queryByText('+ Add your first connection')).toBeNull();
    expect(screen.getByText('No connections yet')).toBeInTheDocument();
  });

  it('disables the Add Connection button in the error state', () => {
    connectionState.error = 'Failed to load connections';
    render(<ConnectionSelector />);

    expect(screen.getByText('+ Add Connection', { selector: 'button' })).toBeDisabled();
  });

  it('ignores the open-add-connection window event', () => {
    render(<ConnectionSelector />);

    act(() => {
      window.dispatchEvent(new CustomEvent('betterdb:open-add-connection'));
    });

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
