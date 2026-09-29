import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { SidebarProvider } from '../ui/sidebar.tsx';
import type { Connection } from '../../hooks/useConnection';

const { connectionState, setConnection } = vi.hoisted(() => {
  return {
    connectionState: {
      currentConnection: null as Connection | null,
      connections: [] as Connection[],
    },
    setConnection: vi.fn(),
  };
});

vi.mock('../../hooks/useConnection', () => ({
  useConnection: () => ({
    currentConnection: connectionState.currentConnection,
    connections: connectionState.connections,
    setConnection,
    loading: false,
    error: null,
    refreshConnections: vi.fn(),
    hasNoConnections: false,
  }),
}));

vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({ hasVectorSearch: false }),
}));

vi.mock('../../hooks/useCacheProposals', () => ({
  useCacheProposalsUnread: () => ({ unreadCount: 0 }),
}));

vi.mock('../../contexts/DemoContext', () => ({
  useIsDemo: () => false,
}));

vi.mock('../../hooks/useCanMutate', () => ({
  useCanMutate: () => true,
}));

vi.mock('../ConnectionSelector', () => ({
  ConnectionSelector: () => null,
}));

function mockCurrent(current: Partial<Connection> & { id: string; name: string }, all: Array<Partial<Connection> & { id: string; name: string }>): void {
  const toConnection = (c: Partial<Connection> & { id: string; name: string }): Connection => ({
    id: c.id,
    name: c.name,
    host: c.host ?? 'h',
    port: c.port ?? 1,
    isConnected: c.isConnected ?? true,
    capabilities: c.capabilities,
    connectionType: c.connectionType,
    autoRegisterNodes: c.autoRegisterNodes,
    membership: c.membership,
  });
  connectionState.currentConnection = toConnection(current);
  connectionState.connections = [connectionState.currentConnection, ...all.map(toConnection)];
}

function renderSidebar(): void {
  render(
    <MemoryRouter>
      <SidebarProvider>
        <AppSidebar cloudUser={null} onFeedbackClick={vi.fn()} onShortcutsClick={vi.fn()} />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('AppSidebar cluster nav gating', () => {
  it('hides seed-only items and links to the cluster when a child node is selected', () => {
    mockCurrent(
      { id: 'k', name: 'prod · 10.0.0.2:7002', membership: { seedId: 's', nodeId: 'n', origin: 'auto', source: 'cluster' } },
      [{ id: 's', name: 'prod' }],
    );
    renderSidebar();
    expect(screen.queryByRole('link', { name: /^Cluster/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Key Analytics/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Migration/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'View cluster → prod' })).toBeInTheDocument();
  });

  it('shows seed-only items for a seed', () => {
    mockCurrent({ id: 's', name: 'prod' }, []);
    renderSidebar();
    expect(screen.getByRole('link', { name: /^Cluster/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Key Analytics/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Migration/ })).toBeInTheDocument();
  });
});
