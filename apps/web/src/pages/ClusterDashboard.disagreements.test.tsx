import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { TopologyDisagreementSummary } from '../types/anomaly';

const state = vi.hoisted(() => ({
  licensed: true,
  licenseLoading: false,
  summary: undefined as TopologyDisagreementSummary | undefined,
  asked: [] as Array<{ connectionId: string | undefined; enabled: boolean }>,
}));

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
vi.mock('../hooks/useClusterDisagreements', () => ({
  useClusterDisagreements: (connectionId: string | undefined, enabled: boolean) => {
    state.asked.push({ connectionId, enabled });
    return {
      licensed: state.licensed,
      licenseLoading: state.licenseLoading,
      summary: state.licensed ? state.summary : undefined,
      error: null,
    };
  },
}));
vi.mock('../components/cluster/ClusterHealthCard', () => ({ ClusterHealthCard: () => null }));
vi.mock('../components/cluster/ClusterTopology', () => ({ ClusterTopology: () => null }));
vi.mock('../components/cluster/SlotHeatmap', () => ({ SlotHeatmap: () => null }));
vi.mock('../components/cluster/ClusterNodesTable', () => ({ ClusterNodesTable: () => null }));
vi.mock('../components/cluster/AvailabilityZonesDialog', () => ({
  AvailabilityZonesDialog: () => null,
}));
vi.mock('../components/cluster/NodeStatsComparison', () => ({ NodeStatsComparison: () => null }));
vi.mock('../components/cluster/ClusterSlowlog', () => ({ ClusterSlowlog: () => null }));
vi.mock('../components/cluster/ReplicationLag', () => ({ ReplicationLag: () => null }));
vi.mock('../components/cluster/SlotMigrations', () => ({ SlotMigrations: () => null }));
vi.mock('../components/cluster/RaftHealthPanel', () => ({ RaftHealthPanel: () => null }));

import { ClusterDashboard } from './ClusterDashboard';

function summaryWith(lines: number): TopologyDisagreementSummary {
  const primary = { nodeId: 'n1', address: 'n1.internal:6379', role: 'primary' as const };
  return {
    status: 'ok',
    sampledAt: 1_704_067_200_000,
    coverage: {
      nodes: 3,
      asked: 3,
      answered: 3,
      complete: true,
      unanswered: [],
      unansweredCount: 0,
    },
    disagreements: Array.from({ length: lines }, (_, at) => ({
      id: `failure_flags:n${at}`,
      kind: 'failure_flags' as const,
      severity: 'warning' as const,
      open: true,
      confirmed: false,
      resolvedByHand: false,
      eventId: null,
      eventType: null,
      eventAt: null,
      eventConnectionId: null,
      since: 1_704_067_100_000,
      rounds: 1,
      stale: false,
      lastSeenAt: 1_704_067_200_000,
      subjects: [primary],
      subjectCount: 1,
      shardIds: [],
      positions: [
        { value: 'ok', count: 2, observerCount: 2, observers: [primary] },
        { value: 'fail?', count: 1, observerCount: 1, observers: [primary] },
      ],
      text: `Line ${at}: ok in 2 views, fail? in 1 view.`,
    })),
    shards: [],
  };
}

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

describe('ClusterDashboard disagreements tab', () => {
  beforeEach(() => {
    state.licensed = true;
    state.licenseLoading = false;
    state.summary = summaryWith(2);
    state.asked = [];
  });

  it('opens on the overview and shows how many disagreements there are on the tab', () => {
    open('/cluster');

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    const tab = screen.getByRole('tab', { name: 'Disagreements, 2 open' });
    expect(within(tab).getByText('2')).toBeInTheDocument();
    expect(state.asked.at(-1)).toEqual({ connectionId: 'conn-1', enabled: true });
  });

  it('shows no count while the views agree', () => {
    state.summary = summaryWith(0);

    open('/cluster');

    expect(screen.getByRole('tab', { name: 'Disagreements' })).toBeInTheDocument();
  });

  it('leaves a disagreement the last round could not check out of the count on the tab', () => {
    const summary = summaryWith(2);
    summary.disagreements[1] = {
      ...summary.disagreements[1],
      open: false,
      stale: true,
      positions: [],
    };
    state.summary = summary;

    open('/cluster');

    expect(screen.getByRole('tab', { name: 'Disagreements, 1 open' })).toBeInTheDocument();
  });

  it('shows no count when nothing was confirmed in the last round', () => {
    const summary = summaryWith(1);
    summary.disagreements[0] = {
      ...summary.disagreements[0],
      open: false,
      stale: true,
      positions: [],
    };
    state.summary = summary;

    open('/cluster');

    expect(screen.getByRole('tab', { name: 'Disagreements' })).toBeInTheDocument();
  });

  it('counts the lines the server calls open', () => {
    const summary = summaryWith(3);
    summary.disagreements[0] = { ...summary.disagreements[0], open: false };
    summary.disagreements[1] = { ...summary.disagreements[1], stale: true, positions: [] };
    summary.disagreements[2] = { ...summary.disagreements[2], stale: true, positions: [] };
    state.summary = summary;

    open('/cluster');

    expect(screen.getByRole('tab', { name: 'Disagreements, 2 open' })).toBeInTheDocument();
  });

  it('keeps counting a disagreement with an open event that the last round could not check', () => {
    const summary = summaryWith(1);
    summary.disagreements[0] = {
      ...summary.disagreements[0],
      severity: 'critical',
      confirmed: true,
      eventId: 'event-1',
      eventType: 'topology_divergence',
      eventAt: 1_704_067_150_000,
      eventConnectionId: 'conn-1',
      stale: true,
      positions: [],
    };
    state.summary = summary;

    open('/cluster');

    expect(screen.getByRole('tab', { name: 'Disagreements, 1 open' })).toBeInTheDocument();
  });

  it('waits for the licence before saying the view needs Pro', () => {
    state.licensed = false;
    state.licenseLoading = true;

    open('/cluster?tab=disagreements');

    expect(screen.getByRole('status', { name: 'Loading disagreements' })).toBeInTheDocument();
    expect(
      screen.queryByText('Cluster view disagreements are available in Pro'),
    ).not.toBeInTheDocument();
  });

  it('opens the disagreements when the URL asks for them', () => {
    open('/cluster?connection=conn-1&tab=disagreements');

    expect(screen.getByRole('tab', { name: 'Disagreements, 2 open' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('article', { name: 'Line 0: ok in 2 views, fail? in 1 view.' }),
    ).toBeInTheDocument();
  });

  it('writes the tab to the URL when it is picked', () => {
    open('/cluster?connection=conn-1');

    const tab = screen.getByRole('tab', { name: 'Disagreements, 2 open' });
    fireEvent.mouseDown(tab, { button: 0 });
    fireEvent.click(tab);

    expect(screen.getByLabelText('search')).toHaveTextContent(
      '?connection=conn-1&tab=disagreements',
    );
    expect(
      screen.getByRole('article', { name: 'Line 1: ok in 2 views, fail? in 1 view.' }),
    ).toBeInTheDocument();
  });

  it('says the view needs Pro instead of loading it without the licence', () => {
    state.licensed = false;

    open('/cluster?tab=disagreements');

    expect(screen.getByRole('tab', { name: 'Disagreements' })).toBeInTheDocument();
    expect(screen.getByText('Cluster view disagreements are available in Pro')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading disagreements' })).not.toBeInTheDocument();
  });
});
