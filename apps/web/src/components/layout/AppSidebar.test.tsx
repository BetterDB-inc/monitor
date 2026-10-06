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

  it('keeps Key Analytics on a Sentinel primary, where the data node is the only place to scan', () => {
    mockCurrent(
      { id: 'p', name: 'ha · 10.0.0.5:6379', membership: { seedId: 's', nodeId: 'n', origin: 'auto', source: 'sentinel', group: 'mymaster', role: 'primary' } },
      [{ id: 's', name: 'ha' }],
    );
    renderSidebar();
    expect(screen.getByRole('link', { name: /^Key Analytics/ })).toBeInTheDocument();
  });

  it.each([
    ['a Sentinel replica', { role: 'replica' as const }],
    ['a Sentinel primary that left its group', { role: 'primary' as const, retiredAt: 5 }],
  ])('hides Key Analytics on %s', (_case, membership) => {
    mockCurrent(
      { id: 'r', name: 'ha · 10.0.0.6:6379', membership: { seedId: 's', nodeId: 'n', origin: 'adopted', source: 'sentinel', group: 'mymaster', ...membership } },
      [{ id: 's', name: 'ha' }],
    );
    renderSidebar();
    expect(screen.queryByRole('link', { name: /^Key Analytics/ })).toBeNull();
  });

  it('falls back to the Cluster link when a child has no seed in the list', () => {
    mockCurrent(
      { id: 'k', name: 'prod · 10.0.0.2:7002', membership: { seedId: 'gone', nodeId: 'n', origin: 'auto', source: 'cluster' } },
      [],
    );
    renderSidebar();
    expect(screen.getByRole('link', { name: /^Cluster/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View cluster/ })).toBeNull();
  });

  it('shows seed-only items for a seed', () => {
    mockCurrent({ id: 's', name: 'prod' }, []);
    renderSidebar();
    expect(screen.getByRole('link', { name: /^Cluster/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Key Analytics/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Migration/ })).toBeInTheDocument();
  });
});
