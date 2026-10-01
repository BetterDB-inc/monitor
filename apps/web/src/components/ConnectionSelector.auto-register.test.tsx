import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockRefreshConnections = vi.fn().mockResolvedValue(undefined);

const connectionState = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  autoRegisterNodesDefault: false,
}));

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: null,
    connections: connectionState.connections,
    loading: false,
    error: null,
    setConnection: vi.fn(),
    refreshConnections: mockRefreshConnections,
    hasNoConnections: connectionState.connections.length === 0,
    autoRegisterNodesDefault: connectionState.autoRegisterNodesDefault,
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

const seed = {
  id: 'seed',
  name: 'Prod cluster',
  host: 'seed.local',
  port: 7001,
  isConnected: true,
  connectionType: 'direct',
  capabilities: { dbType: 'valkey', version: '8.0.0', clusterEnabled: true },
};

type Call = [string, RequestInit | undefined];

function patchCalls(): Call[] {
  return (vi.mocked(fetchApi).mock.calls as Call[]).filter(([, init]) => init?.method === 'PATCH');
}

function routeFetch(options: { patchError?: Error; sentinel?: boolean } = {}) {
  vi.mocked(fetchApi).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/connections/test') {
      return {
        success: true,
        capabilities: options.sentinel ? { isSentinel: true } : { clusterEnabled: true },
      };
    }
    if (url === '/connections' && init?.method === 'POST') return { id: 'new-id' };
    if (init?.method === 'PATCH' && options.patchError) throw options.patchError;
    return {};
  });
}

async function openAddDialogWithClusterTest() {
  fireEvent.click(screen.getByText('+ Add your first connection'));
  fireEvent.change(screen.getByPlaceholderText('Production Redis'), { target: { value: 'New seed' } });
  fireEvent.click(screen.getByText('Test Connection'));
  return screen.findByLabelText('Auto-register cluster nodes');
}

async function openAddDialogWithSentinelTest() {
  fireEvent.click(screen.getByText('+ Add your first connection'));
  fireEvent.change(screen.getByPlaceholderText('Production Redis'), { target: { value: 'New sentinel' } });
  fireEvent.click(screen.getByText('Test Connection'));
  return screen.findByText('Data node credentials');
}

describe('ConnectionSelector - auto-register toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.connections = [];
    connectionState.autoRegisterNodesDefault = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows an unset seed as enabled when the env default is on', () => {
    connectionState.connections = [seed];
    connectionState.autoRegisterNodesDefault = true;
    render(<ConnectionSelector />);
    fireEvent.click(screen.getByText('⚙', { selector: 'button' }));
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('asks for confirmation when unchecking a seed that follows an enabled default', () => {
    connectionState.connections = [seed];
    connectionState.autoRegisterNodesDefault = true;
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<ConnectionSelector />);
    fireEvent.click(screen.getByText('⚙', { selector: 'button' }));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm).toHaveBeenCalled();
    expect(patchCalls()).toEqual([]);
  });

  it('starts the add dialog checkbox at the env default and skips the PATCH when unchanged', async () => {
    connectionState.autoRegisterNodesDefault = true;
    routeFetch();
    render(<ConnectionSelector />);
    const checkbox = await openAddDialogWithClusterTest();
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockRefreshConnections).toHaveBeenCalled());
    expect(patchCalls()).toEqual([]);
  });

  it('patches after create when the user changed the checkbox from the default', async () => {
    connectionState.autoRegisterNodesDefault = true;
    routeFetch();
    render(<ConnectionSelector />);
    const checkbox = await openAddDialogWithClusterTest();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockRefreshConnections).toHaveBeenCalled());
    expect(patchCalls()).toEqual([
      ['/connections/new-id/auto-register', expect.objectContaining({ body: JSON.stringify({ enabled: false }) })],
    ]);
  });

  it('closes the dialog and refreshes even when the follow-up PATCH fails', async () => {
    routeFetch({ patchError: new Error('patch failed') });
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    render(<ConnectionSelector />);
    const checkbox = await openAddDialogWithClusterTest();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockRefreshConnections).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('patch failed'));
  });

  it('shows a data node credentials disclosure for a sentinel seed and sends it on save', async () => {
    routeFetch({ sentinel: true });
    render(<ConnectionSelector />);
    const disclosureSummary = await openAddDialogWithSentinelTest();
    fireEvent.click(disclosureSummary);
    const nodeUsernameInput = screen
      .getByText('Node username')
      .closest('div')!
      .querySelector('input') as HTMLInputElement;
    const nodePasswordInput = screen
      .getByText('Node password')
      .closest('div')!
      .querySelector('input') as HTMLInputElement;
    fireEvent.change(nodeUsernameInput, { target: { value: 'node-user' } });
    fireEvent.change(nodePasswordInput, { target: { value: 'node-pass' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockRefreshConnections).toHaveBeenCalled());
    const createCall = vi
      .mocked(fetchApi)
      .mock.calls.find(([url, init]) => url === '/connections' && (init as RequestInit)?.method === 'POST');
    expect(createCall).toBeDefined();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.nodeUsername).toBe('node-user');
    expect(body.nodePassword).toBe('node-pass');
  });

  it('sends an empty node username when data nodes should use no username', async () => {
    routeFetch({ sentinel: true });
    render(<ConnectionSelector />);
    const disclosureSummary = await openAddDialogWithSentinelTest();
    fireEvent.click(disclosureSummary);
    fireEvent.click(screen.getByLabelText('Connect to data nodes without a username'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockRefreshConnections).toHaveBeenCalled());
    const createCall = vi
      .mocked(fetchApi)
      .mock.calls.find(([url, init]) => url === '/connections' && (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.nodeUsername).toBe('');
  });

  it('omits the node username when it is left blank so data nodes inherit the seed username', async () => {
    routeFetch({ sentinel: true });
    render(<ConnectionSelector />);
    await openAddDialogWithSentinelTest();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockRefreshConnections).toHaveBeenCalled());
    const createCall = vi
      .mocked(fetchApi)
      .mock.calls.find(([url, init]) => url === '/connections' && (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect('nodeUsername' in body).toBe(false);
  });

  it('keeps node credentials when only the name changes after a sentinel test', async () => {
    routeFetch({ sentinel: true });
    render(<ConnectionSelector />);
    const disclosureSummary = await openAddDialogWithSentinelTest();
    fireEvent.click(disclosureSummary);
    const nodeUsernameInput = screen
      .getByText('Node username')
      .closest('div')!
      .querySelector('input') as HTMLInputElement;
    fireEvent.change(nodeUsernameInput, { target: { value: 'node-user' } });
    fireEvent.change(screen.getByPlaceholderText('Production Redis'), { target: { value: 'Renamed' } });
    expect(screen.getByText('Node username')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockRefreshConnections).toHaveBeenCalled());
    const createCall = vi
      .mocked(fetchApi)
      .mock.calls.find(([url, init]) => url === '/connections' && (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.name).toBe('Renamed');
    expect(body.nodeUsername).toBe('node-user');
  });

  it('drops stale node credentials when a re-test comes back non-Sentinel', async () => {
    let sentinel = true;
    vi.mocked(fetchApi).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/connections/test') {
        return {
          success: true,
          capabilities: sentinel ? { isSentinel: true } : { clusterEnabled: true },
        };
      }
      if (url === '/connections' && init?.method === 'POST') return { id: 'new-id' };
      return {};
    });
    render(<ConnectionSelector />);
    const disclosureSummary = await openAddDialogWithSentinelTest();
    fireEvent.click(disclosureSummary);
    const nodeUsernameInput = screen
      .getByText('Node username')
      .closest('div')!
      .querySelector('input') as HTMLInputElement;
    const nodePasswordInput = screen
      .getByText('Node password')
      .closest('div')!
      .querySelector('input') as HTMLInputElement;
    fireEvent.change(nodeUsernameInput, { target: { value: 'node-user' } });
    fireEvent.change(nodePasswordInput, { target: { value: 'node-pass' } });

    // Change the host (clears testResult), then re-test against a non-Sentinel host.
    sentinel = false;
    fireEvent.change(screen.getByPlaceholderText('localhost'), { target: { value: 'plain-host' } });
    fireEvent.click(screen.getByText('Test Connection'));
    await screen.findByLabelText('Auto-register cluster nodes');
    expect(screen.queryByText('Data node credentials')).toBeNull();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockRefreshConnections).toHaveBeenCalled());
    const createCall = vi
      .mocked(fetchApi)
      .mock.calls.find(([url, init]) => url === '/connections' && (init as RequestInit)?.method === 'POST');
    expect(createCall).toBeDefined();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.nodeUsername).toBeUndefined();
    expect(body.nodePassword).toBeUndefined();
  });
});
