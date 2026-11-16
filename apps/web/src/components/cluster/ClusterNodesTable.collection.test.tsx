import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ClusterNode } from '../../types/metrics';

const mocks = vi.hoisted(() => ({ connectClusterNode: vi.fn() }));

vi.mock('../../api/connections', () => ({
  connectionsApi: { connectClusterNode: mocks.connectClusterNode },
}));
vi.mock('../../hooks/useCanMutate', () => ({ useCanMutate: () => true }));

import { ClusterNodesTable } from './ClusterNodesTable';
import { nodeCollectionOf, type NodeCollection } from './nodeCollection';

function clusterNode(overrides: Partial<ClusterNode>): ClusterNode {
  return {
    id: 'a'.repeat(40),
    address: '10.0.0.1:6379@16379',
    flags: ['myself', 'master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 8191]],
    ...overrides,
  };
}

const own = clusterNode({});
const other = clusterNode({
  id: 'b'.repeat(40),
  address: '10.0.0.2:6379@16379',
  flags: ['master'],
  slots: [[8192, 16383]],
});
const CLUSTER_CONNECTION = { id: 'conn-1', host: '10.0.0.1', connectionType: 'direct' as const };

function row(address: string): HTMLElement {
  return screen.getByText(address).closest('tr') as HTMLElement;
}

function renderTable(collection?: ReadonlyMap<string, NodeCollection>, onNodeConnected = vi.fn()) {
  render(
    <MemoryRouter>
      <ClusterNodesTable
        nodes={[own, other]}
        collection={collection}
        clusterConnection={CLUSTER_CONNECTION}
        onNodeConnected={onNodeConnected}
      />
    </MemoryRouter>,
  );
  return onNodeConnected;
}

const COLLECTION = new Map<string, NodeCollection>([
  [own.id, { collected: true, connectionId: 'conn-1' }],
  [other.id, { collected: false }],
]);

describe('nodeCollectionOf', () => {
  it('keeps what the server said about each node and skips a node it said nothing about', () => {
    const collection = nodeCollectionOf([
      { id: 'a', collected: true, connectionId: 'conn-1' },
      { id: 'b', collected: false },
      { id: 'c' },
    ]);

    expect([...collection]).toEqual([
      ['a', { collected: true, connectionId: 'conn-1' }],
      ['b', { collected: false }],
    ]);
  });

  it('is empty before the nodes arrive', () => {
    expect(nodeCollectionOf(null).size).toBe(0);
  });
});

describe('ClusterNodesTable collection', () => {
  beforeEach(() => {
    mocks.connectClusterNode.mockReset();
  });

  it('marks the row of a node that has no connection of its own', () => {
    renderTable(COLLECTION);

    expect(within(row('10.0.0.2:6379@16379')).getByText('Not collected')).toBeInTheDocument();
    expect(within(row('10.0.0.1:6379@16379')).queryByText('Not collected')).not.toBeInTheDocument();
  });

  it('marks no row before it is known which nodes are collected', () => {
    renderTable();

    expect(screen.queryByText('Not collected')).not.toBeInTheDocument();
  });

  it('offers to connect the node in its open row, by its client address', () => {
    renderTable(COLLECTION);

    fireEvent.click(row('10.0.0.2:6379@16379'));

    expect(screen.getByText(/^10\.0\.0\.2:6379 is not registered as its own connection\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect to this node' })).toBeInTheDocument();
  });

  it('offers nothing in the open row of a collected node', () => {
    renderTable(COLLECTION);

    fireEvent.click(row('10.0.0.1:6379@16379'));

    expect(screen.queryByRole('button', { name: 'Connect to this node' })).not.toBeInTheDocument();
  });

  it('keeps the row open and tells the page once the node is connected', async () => {
    mocks.connectClusterNode.mockResolvedValue({ id: 'conn-node', created: true });
    const onNodeConnected = renderTable(COLLECTION);
    fireEvent.click(row('10.0.0.2:6379@16379'));

    fireEvent.click(screen.getByRole('button', { name: 'Connect to this node' }));

    expect(await screen.findByRole('link', { name: 'Open node dashboard' })).toBeInTheDocument();
    expect(mocks.connectClusterNode).toHaveBeenCalledWith('conn-1', other.id);
    expect(onNodeConnected).toHaveBeenCalledTimes(1);
    expect(screen.getByText(other.id)).toBeInTheDocument();
  });
});
