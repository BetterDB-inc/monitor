import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ClusterNode } from '../../types/metrics';
import { ClusterNodesTable } from './ClusterNodesTable';
import { ClusterTopology } from './ClusterTopology';
import { graphNodeHealth } from './nodeHealth';

function clusterNode(overrides: Partial<ClusterNode>): ClusterNode {
  return {
    id: 'e2e5e98c4e177833752687117b54cbeefe174953',
    address: '10.0.0.1:6379',
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 16383]],
    ...overrides,
  };
}

const healthy = clusterNode({});
const suspect = clusterNode({ id: 'b'.repeat(40), address: '10.0.0.2:6379', flags: ['master', 'fail?'] });
const failed = clusterNode({ id: 'c'.repeat(40), address: '10.0.0.3:6379', flags: ['master', 'fail'] });

function row(address: string): HTMLElement {
  return screen.getByText(address).closest('tr') as HTMLElement;
}

function addressOrder(): string[] {
  return screen
    .getAllByRole('row')
    .map((tableRow) => tableRow.textContent?.match(/10\.0\.0\.\d+:6379/)?.[0])
    .filter((address): address is string => address !== undefined);
}

describe('ClusterNodesTable node state', () => {
  it('marks a node its peers suspect, and one they agreed has failed', () => {
    render(<ClusterNodesTable nodes={[healthy, suspect, failed]} />);

    expect(within(row('10.0.0.2:6379')).getByText('Suspect')).toBeInTheDocument();
    expect(within(row('10.0.0.3:6379')).getByText('Failed')).toBeInTheDocument();
    expect(within(row('10.0.0.1:6379')).queryByText('Suspect')).not.toBeInTheDocument();
    expect(within(row('10.0.0.1:6379')).queryByText('Failed')).not.toBeInTheDocument();
  });

  it.each([['handshake'], ['noaddr']])('marks a %s node as suspect', (flag) => {
    render(<ClusterNodesTable nodes={[clusterNode({ flags: ['master', flag] })]} />);

    expect(within(row('10.0.0.1:6379')).getByText('Suspect')).toBeInTheDocument();
  });

  it('sorts the State column by node state, then by link state', () => {
    const unlinked = clusterNode({
      id: 'd'.repeat(40),
      address: '10.0.0.4:6379',
      linkState: 'disconnected',
    });
    render(<ClusterNodesTable nodes={[failed, unlinked, suspect, healthy]} />);

    fireEvent.click(screen.getByText('State'));
    expect(addressOrder()).toEqual([
      '10.0.0.1:6379',
      '10.0.0.4:6379',
      '10.0.0.2:6379',
      '10.0.0.3:6379',
    ]);

    fireEvent.click(screen.getByText(/^State/));
    expect(addressOrder()).toEqual([
      '10.0.0.3:6379',
      '10.0.0.2:6379',
      '10.0.0.4:6379',
      '10.0.0.1:6379',
    ]);
  });
});

describe('ClusterTopology node state', () => {
  it('marks a node its peers suspect, and one they agreed has failed', () => {
    render(<ClusterTopology nodes={[healthy, suspect, failed]} />);

    expect(screen.getAllByText('SUSPECT')).toHaveLength(1);
    expect(screen.getAllByText('FAIL')).toHaveLength(1);
  });

  it('marks nothing on a cluster of healthy nodes', () => {
    render(<ClusterTopology nodes={[healthy]} />);

    expect(screen.queryByText('SUSPECT')).not.toBeInTheDocument();
    expect(screen.queryByText('FAIL')).not.toBeInTheDocument();
  });
});

describe('graphNodeHealth', () => {
  it.each([
    [['master'], 'connected', 'healthy'],
    [['master', 'fail?'], 'connected', 'suspect'],
    [['master', 'handshake'], 'connected', 'suspect'],
    [['master', 'noaddr'], 'connected', 'suspect'],
    [['master', 'fail'], 'connected', 'unhealthy'],
    [['master', 'fail?', 'fail'], 'disconnected', 'unhealthy'],
    [['master'], 'disconnected', 'unhealthy'],
    [['master', 'fail?'], 'disconnected', 'unhealthy'],
  ])('reads flags %j on a %s link as %s', (flags, linkState, expected) => {
    expect(graphNodeHealth({ flags, linkState })).toBe(expected);
  });
});
