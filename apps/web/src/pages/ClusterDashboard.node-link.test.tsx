import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { clusterNodePath } from '@betterdb/shared';

const table = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'conn-1' }, refreshConnections: vi.fn() }),
}));
vi.mock('../hooks/useCluster', () => ({
  useCluster: () => ({
    isClusterMode: true,
    isLoading: false,
    error: null,
    info: { cluster_state: 'ok' },
    nodes: [{ id: 'n1', address: 'n1.internal:6379', flags: ['master'], slots: [[0, 16383]] }],
    masters: [],
    replicas: [],
    slotStats: null,
    slotStatsFailedNodes: [],
    hasSlotStats: false,
    health: {
      status: 'healthy',
      slotsOk: 16384,
      slotsFail: 0,
      slotsPfail: 0,
      slotsAssigned: 16384,
      totalSlots: 16384,
    },
    refetch: vi.fn(),
  }),
}));
vi.mock('../hooks/usePolling', () => ({
  usePolling: () => ({ data: null, error: null, loading: false, refresh: vi.fn() }),
}));
vi.mock('../components/cluster/ClusterHealthCard', () => ({ ClusterHealthCard: () => null }));
vi.mock('../components/cluster/ClusterTopology', () => ({ ClusterTopology: () => null }));
vi.mock('../components/cluster/SlotHeatmap', () => ({ SlotHeatmap: () => null }));
vi.mock('../components/cluster/ClusterNodesTable', () => ({
  ClusterNodesTable: (props: Record<string, unknown>) => {
    table.props.push(props);
    return <div data-testid="nodes-table" />;
  },
}));
vi.mock('../components/cluster/AvailabilityZonesDialog', () => ({
  AvailabilityZonesDialog: () => null,
}));
vi.mock('../components/cluster/NodeStatsComparison', () => ({ NodeStatsComparison: () => null }));
vi.mock('../components/cluster/ClusterSlowlog', () => ({ ClusterSlowlog: () => null }));
vi.mock('../components/cluster/ReplicationLag', () => ({ ReplicationLag: () => null }));
vi.mock('../components/cluster/SlotMigrations', () => ({ SlotMigrations: () => null }));
vi.mock('../components/cluster/RaftHealthPanel', () => ({ RaftHealthPanel: () => null }));

import { ClusterDashboard } from './ClusterDashboard';

function Search() {
  return <output aria-label="search">{useLocation().search}</output>;
}

function open(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ClusterDashboard />
      <Search />
    </MemoryRouter>,
  );
}

describe('ClusterDashboard node link', () => {
  beforeEach(() => {
    table.props = [];
  });

  it('opens the Nodes tab on the node a node link names', () => {
    open(clusterNodePath('n1', 'conn-1'));

    expect(screen.getByRole('tab', { name: 'Nodes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('nodes-table')).toBeInTheDocument();
    expect(table.props.at(-1)).toMatchObject({ focusNodeId: 'n1' });
  });

  it('opens on the overview without a node link', () => {
    open('/cluster');

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('nodes-table')).not.toBeInTheDocument();
  });

  it('picks no node when the Nodes tab is opened by hand', () => {
    open('/cluster?connection=conn-1');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Nodes' }));

    expect(screen.getByLabelText('search')).toHaveTextContent('?connection=conn-1&tab=nodes');
    expect(table.props.at(-1)?.focusNodeId).toBeNull();
  });

  it('forgets the picked node on the way to another tab', () => {
    open(clusterNodePath('n1', 'conn-1'));

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Overview' }));

    expect(screen.getByLabelText('search')).toHaveTextContent('?connection=conn-1');
    expect(screen.getByLabelText('search')).not.toHaveTextContent('node=');
  });
});
