import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the hooks and API before importing the component
const mockConnectionId = 'test-conn-1';

vi.mock('../../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: { id: mockConnectionId, name: 'test' },
  }),
}));

vi.mock('../../hooks/useUpgradePrompt', () => ({
  useUpgradePrompt: () => ({ showUpgradePrompt: vi.fn() }),
}));

const mockGetSession = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();

vi.mock('../../api/command-capture', () => ({
  commandCaptureApi: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
    start: (...args: unknown[]) => mockStart(...args),
    stop: (...args: unknown[]) => mockStop(...args),
  },
}));

import { CommandCaptureControl } from './CommandCaptureControl';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('CommandCaptureControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(null);
  });

  it('renders idle state with start affordance', async () => {
    renderWithClient(<CommandCaptureControl />);
    await waitFor(() => {
      expect(screen.getByText('Start Capture')).toBeInTheDocument();
    });
    expect(screen.getByText('Command Capture')).toBeInTheDocument();
    // Duration presets visible
    expect(screen.getByText('30s')).toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
  });

  it('calls start endpoint with chosen duration', async () => {
    mockStart.mockResolvedValue({
      id: 'sess-1',
      connectionId: mockConnectionId,
      status: 'active',
      startedAt: Date.now(),
      durationMs: 30000,
      expiresAt: Date.now() + 30000,
      commandCount: 0,
    });

    renderWithClient(<CommandCaptureControl />);
    await waitFor(() => {
      expect(screen.getByText('Start Capture')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Start Capture'));

    await waitFor(() => {
      expect(mockStart).toHaveBeenCalledWith({
        connectionId: mockConnectionId,
        durationMs: 30000,
        commandCap: undefined,
      });
    });
  });

  it('renders active state with countdown and stop control', async () => {
    const now = Date.now();
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      connectionId: mockConnectionId,
      status: 'active',
      startedAt: now - 5000,
      durationMs: 60000,
      expiresAt: now + 55000,
      commandCount: 42,
    });

    renderWithClient(<CommandCaptureControl />);
    await waitFor(() => {
      expect(screen.getByText('Capturing')).toBeInTheDocument();
    });
    expect(screen.getByText('Stop Capture')).toBeInTheDocument();
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });

  it('calls stop endpoint when stop is clicked', async () => {
    const now = Date.now();
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      connectionId: mockConnectionId,
      status: 'active',
      startedAt: now,
      durationMs: 60000,
      expiresAt: now + 60000,
      commandCount: 0,
    });
    mockStop.mockResolvedValue({ stopped: true });

    renderWithClient(<CommandCaptureControl />);
    await waitFor(() => {
      expect(screen.getByText('Stop Capture')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Stop Capture'));
    await waitFor(() => {
      expect(mockStop).toHaveBeenCalledWith(mockConnectionId);
    });
  });

  it('renders idle for expired/inactive session', async () => {
    mockGetSession.mockResolvedValue(null);

    renderWithClient(<CommandCaptureControl />);
    await waitFor(() => {
      expect(screen.getByText('Start Capture')).toBeInTheDocument();
    });
    expect(screen.queryByText('Capturing')).not.toBeInTheDocument();
  });
});
