import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock useConnection hook
const mockRefreshConnections = vi.fn().mockResolvedValue(undefined);
const mockSetConnection = vi.fn();

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: null,
    connections: [],
    loading: false,
    error: null,
    setConnection: mockSetConnection,
    refreshConnections: mockRefreshConnections,
    hasNoConnections: true,
  }),
}));

// Mock fetchApi
vi.mock('../api/client', () => ({
  fetchApi: vi.fn(),
  setCurrentConnectionId: vi.fn(),
}));

// Mock cloud APIs used by the Valkey instances tab
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

// Mock shadcn UI components that use @/ imports
vi.mock('./ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>Select</span>,
}));

vi.mock('./ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { ConnectionSelector } from './ConnectionSelector';
import { fetchApi } from '../api/client';

describe('ConnectionSelector - Cancel button resets form state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens add dialog when clicking "+ Add your first connection"', () => {
    render(<ConnectionSelector />);

    fireEvent.click(screen.getByText('+ Add your first connection'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Add Connection')).toBeInTheDocument();
  });

  it('resets form data when Cancel is clicked after editing fields', () => {
    render(<ConnectionSelector />);

    // Open the dialog
    fireEvent.click(screen.getByText('+ Add your first connection'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Fill in the Name field with custom data
    const nameInput = screen.getByPlaceholderText('Production Redis');
    fireEvent.change(nameInput, { target: { value: 'My Custom Connection' } });
    expect(nameInput).toHaveValue('My Custom Connection');

    // Fill in the Host field
    const hostInput = screen.getByPlaceholderText('localhost');
    fireEvent.change(hostInput, { target: { value: 'redis.example.com' } });
    expect(hostInput).toHaveValue('redis.example.com');

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Dialog should be closed
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Reopen the dialog
    fireEvent.click(screen.getByText('+ Add your first connection'));

    // Fields should be reset to defaults
    expect(screen.getByPlaceholderText('Production Redis')).toHaveValue('');
    expect(screen.getByPlaceholderText('localhost')).toHaveValue('localhost');
  });

  it('clears test result when Cancel is clicked after a failed test', async () => {
    const mockFetchApi = vi.mocked(fetchApi);
    mockFetchApi.mockRejectedValueOnce(new Error('Connection refused'));

    render(<ConnectionSelector />);

    // Open dialog
    fireEvent.click(screen.getByText('+ Add your first connection'));

    // Trigger a test connection to create a testResult
    fireEvent.click(screen.getByText('Test Connection'));

    // Wait for the error message to appear
    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Reopen dialog
    fireEvent.click(screen.getByText('+ Add your first connection'));

    // Error message should be gone
    expect(screen.queryByText('Connection refused')).not.toBeInTheDocument();
  });

  it('resets both form data and test result when Cancel is clicked', async () => {
    const mockFetchApi = vi.mocked(fetchApi);
    mockFetchApi.mockResolvedValueOnce({ success: true });

    render(<ConnectionSelector />);

    // Open dialog
    fireEvent.click(screen.getByText('+ Add your first connection'));

    // Fill in some data
    const nameInput = screen.getByPlaceholderText('Production Redis');
    fireEvent.change(nameInput, { target: { value: 'Test Server' } });

    // Run a successful test
    fireEvent.click(screen.getByText('Test Connection'));
    await waitFor(() => {
      expect(screen.getByText('Connection successful!')).toBeInTheDocument();
    });

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Reopen dialog
    fireEvent.click(screen.getByText('+ Add your first connection'));

    // Both should be reset
    expect(screen.getByPlaceholderText('Production Redis')).toHaveValue('');
    expect(screen.queryByText('Connection successful!')).not.toBeInTheDocument();
  });
});

describe('ConnectionSelector - open-add-connection event prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the dialog with prefilled fields from the event detail', () => {
    render(<ConnectionSelector />);

    fireEvent(
      window,
      new CustomEvent('betterdb:open-add-connection', {
        detail: {
          prefill: {
            name: 'my-db.upstash.io',
            host: 'my-db.upstash.io',
            port: 6379,
            username: '',
            password: 'token',
            dbIndex: 0,
            tls: true,
          },
        },
      })
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Production Redis')).toHaveValue('my-db.upstash.io');
    expect(screen.getByPlaceholderText('localhost')).toHaveValue('my-db.upstash.io');
    expect(screen.getByLabelText('Use TLS', { exact: false })).toBeChecked();
  });

  it('opens the dialog with defaults when the event has no detail', () => {
    render(<ConnectionSelector />);

    fireEvent(window, new CustomEvent('betterdb:open-add-connection'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('localhost')).toHaveValue('localhost');
  });

  it('opens the Valkey instances tab with 1gb preselected in cloud mode', async () => {
    render(<ConnectionSelector isCloudMode />);

    fireEvent(
      window,
      new CustomEvent('betterdb:open-add-connection', {
        detail: { tab: 'valkey', valkeyMaxmemory: '1gb' },
      })
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByDisplayValue('1gb')).toBeInTheDocument();
    });
  });

  it('ignores the tab detail outside cloud mode', () => {
    render(<ConnectionSelector />);

    fireEvent(
      window,
      new CustomEvent('betterdb:open-add-connection', { detail: { tab: 'valkey' } })
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Still the direct-connection form
    expect(screen.getByPlaceholderText('localhost')).toBeInTheDocument();
  });
});

describe('ConnectionSelector - connection URL paste into Host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function pasteIntoHost(hostInput: HTMLElement, text: string) {
    fireEvent.paste(hostInput, {
      clipboardData: { getData: () => text },
    });
  }

  it('expands a pasted rediss:// URL into all form fields', () => {
    render(<ConnectionSelector />);

    fireEvent.click(screen.getByText('+ Add your first connection'));

    const hostInput = screen.getByPlaceholderText('localhost');
    pasteIntoHost(hostInput, 'rediss://myuser:s3cret@my-db.upstash.io:6380/2');

    expect(hostInput).toHaveValue('my-db.upstash.io');
    expect(screen.getByPlaceholderText('Production Redis')).toHaveValue('my-db.upstash.io');
    expect(screen.getByPlaceholderText('default')).toHaveValue('myuser');
    expect(screen.getByLabelText('Use TLS', { exact: false })).toBeChecked();
  });

  it('keeps an existing name when expanding a pasted URL', () => {
    render(<ConnectionSelector />);

    fireEvent.click(screen.getByText('+ Add your first connection'));

    fireEvent.change(screen.getByPlaceholderText('Production Redis'), {
      target: { value: 'My Prod' },
    });
    pasteIntoHost(screen.getByPlaceholderText('localhost'), 'redis://host.example.com:7000');

    expect(screen.getByPlaceholderText('Production Redis')).toHaveValue('My Prod');
    expect(screen.getByPlaceholderText('localhost')).toHaveValue('host.example.com');
  });

  it('does not expand while a URL is being typed character by character', () => {
    render(<ConnectionSelector />);

    fireEvent.click(screen.getByText('+ Add your first connection'));

    const hostInput = screen.getByPlaceholderText('localhost');
    const partial = 'rediss://myuser';
    let typed = '';
    for (const char of partial) {
      typed += char;
      fireEvent.change(hostInput, { target: { value: typed } });
    }

    // The literal text stays in the host field; no fields get scattered.
    expect(hostInput).toHaveValue('rediss://myuser');
    expect(screen.getByPlaceholderText('default')).toHaveValue('');
    expect(screen.getByLabelText('Use TLS', { exact: false })).not.toBeChecked();
  });

  it('still strips plain https:// prefixes without expanding', () => {
    render(<ConnectionSelector />);

    fireEvent.click(screen.getByText('+ Add your first connection'));

    const hostInput = screen.getByPlaceholderText('localhost');
    fireEvent.change(hostInput, { target: { value: 'https://host.example.com/' } });

    expect(hostInput).toHaveValue('host.example.com');
  });
});
