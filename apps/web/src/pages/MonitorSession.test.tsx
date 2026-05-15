import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { StoredCaptureSession } from '@betterdb/shared';

// --- mocks (hoisted before imports) ---

const { mockInvalidateQueries, mockStopSession } = vi.hoisted(() => ({
  mockInvalidateQueries: vi.fn().mockResolvedValue(undefined),
  mockStopSession: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'session-abc' }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

vi.mock('../api/monitor', () => ({
  monitorApi: { stopSession: mockStopSession },
}));

vi.mock('../hooks/useMonitorTail', () => ({
  useMonitorTail: () => ({
    lines: [],
    totalReceived: 0,
    bufferTrimmed: false,
    status: 'connecting',
    errorMessage: null,
    paused: false,
    pause: vi.fn(),
    resume: vi.fn(),
  }),
}));

vi.mock('../hooks/useLicense', () => ({
  useLicense: () => ({ hasFeature: () => false }),
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => null,
  OctagonX: () => null,
}));

vi.mock('./monitor/tail-view', () => ({
  TailView: () => <div data-testid="tail-view" />,
}));

vi.mock('./monitor/cross-reference-panel', () => ({
  CrossReferencePanel: () => <div data-testid="cross-reference-panel" />,
}));

vi.mock('./monitor/filters-and-export', () => ({
  FiltersAndExport: () => <div data-testid="filters-and-export" />,
}));

vi.mock('./monitor/compare-captures-panel', () => ({
  CompareCapturesPanel: () => <div data-testid="compare-captures-panel" />,
}));

vi.mock('./monitor/session-status-badge', () => ({
  SessionStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

vi.mock('../components/ui/card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('../components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

// --- actual imports ---

import { useQuery } from '@tanstack/react-query';
import { MonitorSession } from './MonitorSession';

// --- fixtures ---

const BASE_SESSION: StoredCaptureSession = {
  id: 'session-abc',
  connectionId: 'conn-1',
  status: 'running',
  source: 'manual',
  startedAt: Date.now() - 10_000,
  byteCount: 1024,
  lineCount: 100,
  byteCap: 10_000_000,
  lineCap: 100_000,
};

// --- tests ---

describe('MonitorSession — stop session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useQuery).mockReturnValue({
      data: BASE_SESSION,
      isLoading: false,
      error: null,
    } as ReturnType<typeof useQuery>);
  });

  it('shows the Stop button when the session is running', () => {
    render(<MonitorSession />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('does not show the Stop button when the session is not running', () => {
    vi.mocked(useQuery).mockReturnValue({
      data: { ...BASE_SESSION, status: 'completed' },
      isLoading: false,
      error: null,
    } as ReturnType<typeof useQuery>);
    render(<MonitorSession />);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('opens the confirmation dialog when Stop is clicked', () => {
    render(<MonitorSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Stop capture session?')).toBeInTheDocument();
  });

  it('dialog explains the capture cannot be resumed but data is preserved', () => {
    render(<MonitorSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText(/cannot be resumed/i)).toBeInTheDocument();
    expect(screen.getByText(/preserved/i)).toBeInTheDocument();
  });

  it('closes the dialog without calling the API when Cancel is clicked', () => {
    render(<MonitorSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockStopSession).not.toHaveBeenCalled();
  });

  it('calls stopSession with the correct session id on confirm', async () => {
    mockStopSession.mockResolvedValueOnce({ ...BASE_SESSION, status: 'completed' });
    render(<MonitorSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await waitFor(() => {
      expect(mockStopSession).toHaveBeenCalledWith('session-abc');
    });
  });

  it('invalidates the session query after a successful stop', async () => {
    mockStopSession.mockResolvedValueOnce({ ...BASE_SESSION, status: 'completed' });
    render(<MonitorSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['monitor', 'session', 'session-abc'],
      });
    });
  });

  it('closes the dialog after a successful stop', async () => {
    mockStopSession.mockResolvedValueOnce({ ...BASE_SESSION, status: 'completed' });
    render(<MonitorSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows an error message and keeps the dialog open if stopSession fails', async () => {
    mockStopSession.mockRejectedValueOnce(new Error('Server unavailable'));
    render(<MonitorSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await waitFor(() => {
      expect(screen.getByText('Server unavailable')).toBeInTheDocument();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows Stopping… and disables the confirm button while the request is in flight', async () => {
    let resolve!: (v: StoredCaptureSession) => void;
    mockStopSession.mockReturnValueOnce(
      new Promise<StoredCaptureSession>((res) => {
        resolve = res;
      }),
    );
    render(<MonitorSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeDisabled();
    // Clean up the dangling promise
    resolve({ ...BASE_SESSION, status: 'completed' });
  });
});
