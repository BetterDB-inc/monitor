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
