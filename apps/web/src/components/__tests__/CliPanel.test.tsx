import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CliPanel } from '../CliPanel';

// Mock the hooks
vi.mock('@/hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: { id: 'test-conn', name: 'Test Connection' },
    connections: [],
    loading: false,
    error: null,
    setConnection: vi.fn(),
    refreshConnections: vi.fn(),
    hasNoConnections: false,
  }),
}));

vi.mock('@/hooks/useCliWebSocket', () => ({
  useCliWebSocket: () => ({
    send: vi.fn(),
    isConnected: false,
  }),
}));

describe('CliPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    const { container } = render(<CliPanel isOpen={false} onToggle={vi.fn()} onClose={vi.fn()} />);
    expect(container).toBeTruthy();
  });

  it('shows Terminal icon and CLI text in collapsed state', () => {
    render(<CliPanel isOpen={false} onToggle={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('CLI')).toBeInTheDocument();
  });

  it('shows input when expanded', () => {
    render(<CliPanel isOpen={true} onToggle={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText('Connecting...')).toBeInTheDocument();
  });

  it('shows help text when expanded and empty', () => {
    render(<CliPanel isOpen={true} onToggle={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Type "help"/)).toBeInTheDocument();
  });
});
